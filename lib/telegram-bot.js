const crypto = require("crypto");
const { cleanError } = require("./crypto");
const { publish, generate, check } = require("./poster");
const { textHash, panelUrl, draftMessage, botToken } = require("./notify");

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

const COMMANDS = [
  { command: "check", description: "Проверить новые коммиты сейчас" },
  { command: "status", description: "Состояние: репозиторий, режим, черновики" },
  { command: "help", description: "Список команд" },
];

const HELP_TEXT = [
  "Команды:",
  "/check — проверить новые коммиты сейчас, без паузы. Если они есть, пришлю черновик с кнопками.",
  "/status — репозиторий, режим, последняя проверка, сколько черновиков ждёт.",
  "/help — этот список.",
  "",
  "Пост уходит в канал только после кнопки «Опубликовать».",
].join("\n");

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
 * Дата коммита или проверки в часовом поясе из настроек: «20 окт., 13:05».
 */
function formatDate(iso, ctx) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return d.toLocaleString("ru-RU", { ...opts, timeZone: ctx.get("digest_tz", "Europe/Moscow") });
  } catch {
    return d.toLocaleString("ru-RU", { ...opts, timeZone: "UTC" }) + " UTC";
  }
}

const MODE_NAMES = {
  approve: "черновики, публикация по кнопке",
  auto: "публикация сразу",
  digest: "дайджест раз в день",
};

function statusText(ctx) {
  const repo = ctx.get("repo");
  const lastCheck = ctx.get("last_check");
  const lastError = ctx.get("last_error");
  const drafts = ctx.getCounts ? ctx.getCounts().draft : 0;
  const channel = ctx.get("channel_id");
  const lines = [
    `Репозиторий: ${repo ? `${repo}, ветка ${ctx.get("branch", "main")}` : "не выбран"}`,
    `Режим: ${MODE_NAMES[ctx.get("mode", "approve")] || ctx.get("mode")}`,
    `Последняя проверка: ${lastCheck ? formatDate(lastCheck, ctx) : "ещё не было"}`,
  ];
  if (lastError) lines.push(`Ошибка проверки: ${lastError}`);
  lines.push(`Черновиков ждёт: ${drafts}`);
  lines.push(`Канал: ${channel ? `подключён (${channel})` : "не подключён"}`);
  return lines.join("\n");
}

const keyboard = (...rows) => ({ inline_keyboard: rows });
const regenRejectRow = (id, regenLabel = "Другой вариант") => [
  { text: regenLabel, callback_data: `regen:${id}` },
  { text: "Отклонить", callback_data: `rej:${id}` },
];

/**
 * Сообщение об итоге генерации поста для владельца.
 */
function postResultMessage(ctx, id) {
  const p = ctx.post(id);
  if (!p) return { text: `Пост #${id} не найден.` };
  if (p.status === "draft") return draftMessage(p, ctx);
  if (p.status === "skipped") {
    return {
      text: `Пост #${id}: ИИ решил, что подписчикам эти изменения неинтересны.`,
      reply_markup: keyboard(regenRejectRow(id, "Всё равно написать")),
    };
  }
  if (p.status === "sent") return { text: `Пост #${id} опубликован в канал.` };
  if (p.status === "failed") {
    return { text: `Не удалось написать пост #${id}: ${p.error || "неизвестная ошибка"}`, reply_markup: keyboard(regenRejectRow(id)) };
  }
  return { text: `Пост #${id}: статус «${p.status}».` };
}

/**
 * /check: проверка без паузы debounce. Итог одним сообщением (или черновиками).
 */
async function runCheckCommand(ctx, send) {
  const result = await check(true, ctx, { silent: true });
  const latest = result.latest ? `${result.latest.sha.slice(0, 7)}, ${formatDate(result.latest.date, ctx)}` : "";

  switch (result.status) {
    case "busy":
      return send({ text: "Проверка уже идёт. Повторите /check через минуту." });
    case "not_configured":
      return send({ text: `GitHub или репозиторий не настроены. Откройте панель: ${panelUrl(ctx)}` });
    case "error":
      return send({ text: `Не удалось проверить GitHub: ${result.error}` });
    case "first_run":
      return send({ text: `Репозиторий подключён, запомнил последний коммит: ${latest}. Посты будут с новых коммитов.` });
    case "created":
      for (const p of result.posts) await send(postResultMessage(ctx, p.id));
      return null;
    default:
      return send({ text: latest ? `Новых коммитов нет. Последний: ${latest}` : "Новых коммитов нет. В ветке пока нет коммитов." });
  }
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
        await send({ text: `Вы привязаны как владелец бота (${uname}).\n\n${HELP_TEXT}` });
        await registerCommands(ctx, token);
      }
      return;
    }

    if (command === "/start" || command === "/help") return send({ text: HELP_TEXT });
    if (command === "/status") return send({ text: statusText(ctx) });
    if (command === "/check") {
      await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      // Генерация может идти минуту-две: не держим цикл обновлений, итог придёт отдельным сообщением
      runCheckCommand(ctx, send).catch((err) => send({ text: "Ошибка проверки: " + cleanError(err.message) }).catch(() => {}));
      return;
    }
    return send({ text: "Не знаю такой команды. /help — список команд." });
  }

  // 3. Кнопки под черновиками
  if (u.callback_query) {
    const cb = u.callback_query;
    const answer = (text, alert = false) =>
      tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) });

    // Чужому — пустой ответ, чтобы у него погасла «загрузка» на кнопке, и больше ничего
    if (!owner || String(cb.from?.id) !== owner) return answer();

    const [action, rawId, hash] = String(cb.data || "").split(":");
    const id = Number(rawId);
    const msg = cb.message;
    // Меняем исходное сообщение: новый текст, без кнопок (или с новыми)
    const edit = (payload) =>
      msg?.message_id && msg?.chat?.id
        ? tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, ...payload }).catch(() => {})
        : null;
    const editSuffix = (suffix) => edit({ text: `${msg?.text || ""}\n\n${suffix}` });

    try {
      const p = ctx.post(id);
      if (!p) return answer("Пост не найден: возможно, его удалили в панели.", true);

      if (action === "pub" || action === "pubf") {
        // Текст изменился после этого сообщения (правка в панели или новый вариант): не публикуем вслепую
        if (hash && textHash(p.text) !== hash) {
          await answer("Текст поста изменился. Прислал актуальную версию ниже.", true);
          if (p.status === "draft") await tg("sendMessage", { chat_id: owner, ...draftMessage(p, ctx) });
          return null;
        }
        if (action === "pub" && p.status === "failed" && p.interrupted) {
          await answer();
          return tg("sendMessage", {
            chat_id: owner,
            text: `Отправка поста #${id} прервалась, и он мог уже появиться в канале. Проверьте канал. Если поста там нет, отправьте ещё раз.`,
            reply_markup: keyboard([{ text: "Отправить ещё раз", callback_data: `pubf:${id}:${textHash(p.text)}` }]),
          });
        }
        await publish(id, null, ctx);
        await answer("Опубликовано в канал.");
        return editSuffix("Опубликован в канал.");
      }

      if (action === "regen") {
        await answer("Пишу новый вариант…");
        await edit({ text: `${p.kind === "digest" ? "Дайджест" : "Черновик"} #${id}\n\nПишу новый вариант…` });
        // Не держим цикл обновлений, пока ИИ пишет
        generate(id, true, ctx, p.kind === "digest", { notify: false })
          .then(() => edit(postResultMessage(ctx, id)))
          .catch((err) => edit({ text: `Пост #${id}: ${cleanError(err.message)}` }));
        return null;
      }

      if (action === "rej") {
        const res = ctx.db
          .prepare("update posts set status='rejected' where id=? and status in ('draft','failed','skipped')")
          .run(id);
        if (res.changes === 0) return answer("Пост уже обработан: отправлен, отклонён или сейчас в работе.", true);
        await answer("Отклонён.");
        return editSuffix("Отклонён.");
      }

      return answer();
    } catch (err) {
      return answer("Ошибка: " + cleanError(err.message), true);
    }
  }
  return null;
}

module.exports = {
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
