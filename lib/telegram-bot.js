const crypto = require("crypto");
const { cleanError } = require("./crypto");
const { botToken } = require("./notify");
const commands = require("./bot-commands");
const { COMMANDS, HELP_TEXT, statusText, runCheckCommand } = commands;

const OWNER_CODE_TTL_MS = 10 * 60 * 1000;

const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");

/**
 * Выпуск одноразового кода привязки владельца. В БД хранится только хеш кода.
 */
function createOwnerCode(ctx) {
  const code = crypto.randomBytes(6).toString("hex");
  ctx.set("tg_owner_code_hash", hashCode(code));
  ctx.set("tg_owner_code_exp", String(Date.now() + OWNER_CODE_TTL_MS));
  return { code, expiresAt: Date.now() + OWNER_CODE_TTL_MS };
}

function clearOwnerCode(ctx) {
  ctx.set("tg_owner_code_hash", "");
  ctx.set("tg_owner_code_exp", "");
}

/**
 * Проверка кода за постоянное время. Истёкший код удаляется.
 */
function checkOwnerCode(ctx, code) {
  const stored = ctx.get("tg_owner_code_hash");
  const exp = Number(ctx.get("tg_owner_code_exp")) || 0;
  if (!stored || !code) return false;
  if (Date.now() > exp) {
    clearOwnerCode(ctx);
    return false;
  }
  const a = Buffer.from(hashCode(code), "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ===== Сведения о боте (getMe) =====
// Хранятся в базе вместе с отпечатком токена (не самим токеном): после смены TG_BOT_TOKEN
// старые сведения не показываются.
const tokenFingerprint = (token) => crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);

async function refreshBotInfo(ctx) {
  const token = botToken(ctx);
  if (!token) return null;
  let info;
  try {
    const me = await ctx.tg("getMe", {}, token);
    info = me?.ok
      ? { id: me.result?.id, username: me.result?.username || "", error: "" }
      : { error: "Telegram не принял токен: " + cleanError(me?.description || "неизвестная ошибка") };
  } catch (err) {
    info = { error: cleanError(err.message) };
  }
  info = { ...info, fingerprint: tokenFingerprint(token), checked_at: new Date().toISOString() };
  ctx.set("tg_bot_info", JSON.stringify(info));
  return info;
}

function botInfo(ctx) {
  const token = botToken(ctx);
  if (!token) return null;
  try {
    const info = JSON.parse(ctx.get("tg_bot_info") || "null");
    return info && info.fingerprint === tokenFingerprint(token) ? info : null;
  } catch {
    return null;
  }
}

/**
 * Проверка бота и его прав в канале: getMe, затем getChatMember. → { ok, message, status? }
 * Используется кнопкой «Проверить» в панели и командой /channel в боте.
 */
async function checkChannel(ctx) {
  const token = botToken(ctx);
  if (!token) return { ok: false, message: "Бот не настроен: задайте TG_BOT_TOKEN в .env и перезапустите сервер" };

  const info = await refreshBotInfo(ctx);
  if (info.error) return { ok: false, message: info.error };
  const bot = "@" + info.username;

  const channelId = ctx.get("channel_id");
  if (!channelId) {
    return {
      ok: true,
      message: `Бот ${bot} работает. Канал не задан: добавьте ${bot} администратором канала с правом публикации ` +
        "со своего аккаунта (если вы привязаны как владелец, канал подставится сам) или впишите @канал в поле «Канал».",
    };
  }

  let member;
  try {
    member = await ctx.tg("getChatMember", { chat_id: channelId, user_id: info.id }, token);
  } catch (err) {
    return { ok: false, message: `Бот ${bot} работает, но канал проверить не удалось: ${cleanError(err.message)}` };
  }
  if (!member.ok) {
    return { ok: false, message: `Бот ${bot} работает, но Telegram не дал доступа к каналу ${channelId}: ${cleanError(member.description)}. Добавьте ${bot} администратором канала.` };
  }
  const st = member.result?.status;
  if (st === "creator" || (st === "administrator" && member.result?.can_post_messages !== false)) {
    return { ok: true, status: st, message: `Бот ${bot} — администратор канала ${channelId}, может публиковать.` };
  }
  if (st === "administrator") {
    return { ok: false, status: st, message: `Бот ${bot} — администратор канала ${channelId}, но без права публикации. Включите «Публикация сообщений» в правах администратора.` };
  }
  return { ok: false, status: st, message: `Бот ${bot} в канале ${channelId} не администратор (статус «${st}»). Назначьте его администратором с правом публикации.` };
}

/**
 * Команды видны в меню только в личке владельца (scope chat).
 */
async function registerCommands(ctx, token) {
  const owner = ctx.get("tg_owner_chat_id");
  if (!owner || !token) return null;
  return ctx.tg("setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: Number(owner) || owner } }, token);
}

async function unregisterCommands(ctx, token, owner) {
  if (!owner || !token) return null;
  return ctx.tg("deleteMyCommands", { scope: { type: "chat", chat_id: Number(owner) || owner } }, token);
}

/**
 * Обработка одного апдейта Telegram (my_chat_member, личные сообщения, callback-кнопки).
 * Владельцу бот отвечает на команды и кнопки; остальным не отвечает вовсе
 * (кроме привязки по одноразовому коду из панели).
 */
async function handleUpdate(u, ctx, token) {
  const tg = (method, body) => ctx.tg(method, body, token);
  const owner = String(ctx.get("tg_owner_chat_id") || "");

  // 1. Привязка канала: только если канал ещё не задан и бота добавил админом сам владелец.
  //    Иначе любой, кто добавит бота в свой канал, получал бы ваши анонсы.
  const c = u.my_chat_member;
  if (c?.chat?.type === "channel" && c.new_chat_member?.status === "administrator" && !ctx.get("channel_id")) {
    if (owner && String(c.from?.id) === owner) {
      ctx.set("channel_id", c.chat.id);
      console.log("Канал Telegram привязан автоматически:", c.chat.id);
    } else {
      console.log("Бот добавлен в канал не владельцем (или владелец не привязан), канал не привязан:", c.chat.id);
    }
  }

  // 2. Личные сообщения
  if (u.message && u.message.chat?.type === "private") {
    const chatId = String(u.message.chat.id);
    const text = (u.message.text || "").trim();
    const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
    const send = (payload) => tg("sendMessage", { chat_id: chatId, ...payload });

    if (chatId !== owner) {
      // Чужим отвечаем только на успешную привязку по коду
      if (command === "/start" && checkOwnerCode(ctx, text.split(/\s+/)[1] || "")) {
        clearOwnerCode(ctx);
        const from = u.message.from || {};
        const uname = from.username ? "@" + from.username : from.first_name || chatId;
        // Смена владельца: у прежнего убираем меню команд, отвечать ему бот больше не будет
        if (owner) await unregisterCommands(ctx, token, owner).catch(() => null);
        ctx.set("tg_owner_chat_id", chatId);
        ctx.set("tg_owner_username", uname);
        ctx.set("tg_owner_bound_at", new Date().toISOString());
        await send({ text: `Вы привязаны как владелец бота (${uname}).\n\n${HELP_TEXT}` });
        await registerCommands(ctx, token);
      }
      return;
    }

    return commands.handleOwnerMessage(ctx, { chatId, text, tg });
  }

  // 3. Кнопки: только владельцу. Чужому — пустой ответ, чтобы у него погасла «загрузка» на кнопке
  if (u.callback_query) {
    const cb = u.callback_query;
    if (!owner || String(cb.from?.id) !== owner) return tg("answerCallbackQuery", { callback_query_id: cb.id });
    return commands.handleCallback(ctx, { cb, tg, token, owner });
  }
  return null;
}

module.exports = {
  checkChannel,
  OWNER_CODE_TTL_MS,
  COMMANDS,
  createOwnerCode,
  clearOwnerCode,
  checkOwnerCode,
  handleUpdate,
  registerCommands,
  unregisterCommands,
  refreshBotInfo,
  botInfo,
  statusText,
  runCheckCommand,
};
