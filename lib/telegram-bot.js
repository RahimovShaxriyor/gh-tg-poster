const crypto = require("crypto");
const { cleanError } = require("./crypto");
const { botToken, canPost } = require("./notify");
const commands = require("./bot-commands");
const { COMMANDS, HELP_TEXT, statusText, runCheckCommand } = commands;

const OWNER_CODE_TTL_MS = 10 * 60 * 1000;

// Бот один на всю платформу: его сведения — в хранилище платформы, а не в настройках аккаунта
function platformStore(ctx) {
  const p = ctx?.platform || ctx;
  return typeof p?.platformGet === "function" ? { get: p.platformGet, set: p.platformSet } : ctx;
}
// Данные аккаунта поверх общих сервисов (tg, gh, ИИ) из ctx
function userCtxFactory(ctx) {
  const platform = ctx.platform || ctx;
  return (uid) => ({ ...ctx, ...platform.forUser(uid) });
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
  platformStore(ctx).set("tg_bot_info", JSON.stringify(info));
  return info;
}

function botInfo(ctx) {
  const token = botToken(ctx);
  if (!token) return null;
  try {
    const info = JSON.parse(platformStore(ctx).get("tg_bot_info") || "null");
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
 * Подключение канала к аккаунту. Канал подключается, только если привязанный Telegram этого аккаунта —
 * создатель или администратор канала с правом публикации, и канал не подключён к другому аккаунту.
 * Иначе любой мог бы вписать чужой канал, где бот платформы уже администратор, и публиковать туда.
 * → { ok: true, channelId } | { ok: false, status, code, error }
 */
async function linkChannel(ctx, raw) {
  const token = botToken(ctx);
  if (!token) return { ok: false, status: 503, code: "TELEGRAM_BOT_NOT_CONFIGURED", error: "Бот не настроен: задайте TG_BOT_TOKEN в .env и перезапустите сервер" };
  const owner = ctx.get("tg_owner_chat_id");
  if (!owner) {
    return { ok: false, status: 409, code: "TELEGRAM_NOT_LINKED", error: "Сначала привяжите свой Telegram (раздел «Telegram»): так бот проверит, что канал ваш." };
  }
  let chat;
  let member;
  try {
    chat = await ctx.tg("getChat", { chat_id: raw }, token);
    if (chat?.ok) member = await ctx.tg("getChatMember", { chat_id: chat.result.id, user_id: Number(owner) }, token);
  } catch (err) {
    return { ok: false, status: 502, code: "TELEGRAM_NETWORK_ERROR", error: "Telegram недоступен, канал не проверен: " + cleanError(err.message) };
  }
  if (!chat?.ok || !chat.result?.id) {
    return { ok: false, status: 400, code: "TELEGRAM_CHAT_NOT_FOUND", error: `Telegram не нашёл канал ${raw}: проверьте @имя и что бот добавлен в канал администратором.` };
  }
  if (!["channel", "supergroup", "group"].includes(chat.result.type)) {
    return { ok: false, status: 400, code: "TELEGRAM_NOT_A_CHANNEL", error: "Это не канал и не группа." };
  }
  if (!canPost(member)) {
    return { ok: false, status: 403, code: "TELEGRAM_CHANNEL_NOT_OWNED", error: "Ваш привязанный Telegram не администратор этого канала с правом публикации: подключить можно только свой канал." };
  }
  const id = String(chat.result.id);
  const taken = await assignChannel(ctx, id, token);
  if (!taken.ok) return { ok: false, status: 409, code: "TELEGRAM_CHANNEL_TAKEN", error: "Этот канал уже подключён к другому аккаунту, администратор которого сохраняет права в канале." };
  ctx.set("channel_title", String(chat.result.title || "").slice(0, 200));
  ctx.set("channel_username", chat.result.username ? "@" + chat.result.username : "");
  return { ok: true, channelId: id };
}

/**
 * Записывает канал в аккаунт. Канал, занятый другим аккаунтом, переходит, только если у того аккаунта
 * больше нет прав в канале (его Telegram снят с администраторов или не привязан): иначе канал можно было бы
 * «занять» и не отдавать настоящему администратору. → { ok }
 */
async function assignChannel(ctx, channelId, token) {
  const platform = ctx.platform || ctx;
  try {
    ctx.set("channel_id", channelId);
    return { ok: true };
  } catch (err) {
    if (!/UNIQUE/i.test(err.message)) throw err;
  }
  const holderId = ctx.db.prepare("select user_id from user_settings where k='channel_id' and v=? and user_id<>?").get(channelId, ctx.userId)?.user_id;
  if (!holderId) return { ok: false };
  const holder = { ...ctx, ...platform.forUser(holderId) };
  const chat = holder.get("tg_owner_chat_id");
  const member = chat ? await ctx.tg("getChatMember", { chat_id: channelId, user_id: Number(chat) }, token).catch(() => null) : null;
  if (chat && (!member || canPost(member))) return { ok: false }; // права есть или Telegram не ответил — не отбираем
  ctx.db.transaction(() => {
    holder.set("channel_id", "");
    holder.set("channel_title", "");
    holder.set("channel_username", "");
    holder.logEvent("telegram", "Канал отключён: ваш Telegram больше не администратор канала, его подключил администратор канала.");
    ctx.set("channel_id", channelId);
  })();
  return { ok: true };
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
 * Обработка одного апдейта Telegram. Бот один на платформу, поэтому апдейт сначала относится к аккаунту:
 * личный чат и нажавший кнопку — по привязанному chat_id (Telegram сам подтверждает from.id),
 * добавление бота в канал — по тому, кто добавил. Дальше всё идёт с данными только этого аккаунта.
 * Чужим (не привязанным) бот отвечает только на привязку по одноразовому коду из панели.
 */
async function handleUpdate(u, ctx, token) {
  const platform = ctx.platform || ctx;
  const userCtx = userCtxFactory(ctx);
  const tg = (method, body) => ctx.tg(method, body, token);

  // 1. Канал: бот стал администратором канала. Подключаем, только если добавил привязанный
  //    пользователь и у его аккаунта канала ещё нет. Иначе любой, кто добавит бота к себе, получал бы чужие анонсы
  const c = u.my_chat_member;
  if (c?.chat?.type === "channel" && c.new_chat_member?.status === "administrator") {
    const uid = platform.userIdByOwnerChat(String(c.from?.id || ""));
    const uctx = uid ? userCtx(uid) : null;
    if (uctx && !uctx.get("channel_id")) {
      // Добавить бота администратором может только администратор канала, поэтому права у него есть
      const taken = await assignChannel(uctx, String(c.chat.id), token);
      if (taken.ok) {
        uctx.set("channel_title", String(c.chat.title || "").slice(0, 200));
        uctx.set("channel_username", c.chat.username ? "@" + c.chat.username : "");
        console.log(`Канал Telegram подключён к аккаунту #${uid} автоматически`);
      } else {
        console.log(`Канал уже подключён к другому аккаунту, к аккаунту #${uid} не подключён`);
      }
    }
  }

  // 2. Личные сообщения
  if (u.message && u.message.chat?.type === "private") {
    const chatId = String(u.message.chat.id);
    const text = (u.message.text || "").trim();
    const [first, arg = ""] = text.split(/\s+/);
    const command = text.startsWith("/") ? first.split("@")[0].toLowerCase() : "";
    const send = (payload) => tg("sendMessage", { chat_id: chatId, ...payload });
    const bound = platform.userIdByOwnerChat(chatId);

    // Привязка по коду из панели. Чат, уже привязанный к аккаунту, к другому не переходит,
    // пока его не отвяжут (/unlink в боте или «Отвязать» в панели)
    if (command === "/start" && arg) {
      const uid = platform.consumeTgLinkCode(arg);
      if (!uid) return bound ? send({ text: "Код недействителен или устарел. Получите новый в панели." }) : null;
      if (bound && bound !== uid) {
        return send({ text: "Этот Telegram уже привязан к другому аккаунту. Сначала отвяжите его там: команда /unlink в этом чате." });
      }
      const uctx = userCtx(uid);
      const from = u.message.from || {};
      const uname = from.username ? "@" + from.username : from.first_name || chatId;
      const previous = uctx.get("tg_owner_chat_id");
      if (previous && previous !== chatId) await unregisterCommands(uctx, token, previous).catch(() => null);
      try {
        uctx.set("tg_owner_chat_id", chatId);
      } catch (err) {
        if (/UNIQUE/i.test(err.message)) return send({ text: "Этот Telegram уже привязан к другому аккаунту." });
        throw err;
      }
      uctx.set("tg_owner_username", uname);
      uctx.set("tg_owner_bound_at", new Date().toISOString());
      await send({ text: `Telegram привязан к аккаунту ${uctx.username} (${uname}).\n\n${HELP_TEXT}` });
      await registerCommands(uctx, token);
      return null;
    }

    if (!bound) return null;
    const uctx = userCtx(bound);
    if (command === "/unlink") {
      await unregisterCommands(uctx, token, chatId).catch(() => null);
      uctx.set("tg_owner_chat_id", "");
      uctx.set("tg_owner_username", "");
      uctx.set("tg_owner_bound_at", "");
      return send({ text: "Telegram отвязан от аккаунта. Бот больше не будет присылать сюда черновики и отвечать на команды." });
    }
    return commands.handleOwnerMessage(uctx, { chatId, text, tg });
  }

  // 3. Кнопки: только привязанному пользователю и только с его постами.
  //    Чужому — пустой ответ, чтобы у него погасла «загрузка» на кнопке
  if (u.callback_query) {
    const cb = u.callback_query;
    const owner = String(cb.from?.id || "");
    const uid = owner ? platform.userIdByOwnerChat(owner) : null;
    if (!uid) return tg("answerCallbackQuery", { callback_query_id: cb.id });
    return commands.handleCallback(userCtx(uid), { cb, tg, token, owner });
  }
  return null;
}

module.exports = {
  checkChannel,
  OWNER_CODE_TTL_MS,
  COMMANDS,
  linkChannel,
  handleUpdate,
  registerCommands,
  unregisterCommands,
  refreshBotInfo,
  botInfo,
  statusText,
  runCheckCommand,
};
