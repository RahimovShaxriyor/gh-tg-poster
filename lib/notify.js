const crypto = require("crypto");
const { cleanError } = require("./crypto");
const { entitiesOf } = require("../public/tg-format");
const { withFooter } = require("./story");

/**
 * Короткий отпечаток текста поста. Кнопка «Опубликовать» в Telegram несёт отпечаток того текста,
 * который видел владелец: если текст потом изменился (правка в панели, новый вариант), публикации не будет.
 */
const textHash = (text) => crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 10);

/**
 * Внешний адрес панели: PUBLIC_URL, затем DOMAIN (по умолчанию https), затем http://localhost:PORT.
 * От него зависят ссылки в сообщениях бота и адреса возврата приложения GitHub.
 */
function publicBaseUrl(env = process.env) {
  const explicit = String(env.PUBLIC_URL || "").trim();
  const domain = String(env.DOMAIN || "").trim();
  const base = explicit || (domain ? (/^https?:\/\//i.test(domain) ? domain : "https://" + domain) : `http://localhost:${env.PORT || 3000}`);
  return base.replace(/\/+$/, "");
}

const panelUrl = () => publicBaseUrl();

/**
 * Токен бота: TG_BOT_TOKEN из окружения (один бот на весь сервис). Старый токен из базы
 * (его раньше вводили в панели) используется только пока переменная не задана: это переходный режим.
 */
function botTokenSource(ctx) {
  if (String(ctx?.TG_BOT_TOKEN || "").trim()) return "env";
  if (typeof ctx?.getLegacyBotToken === "function" && ctx.getLegacyBotToken()) return "legacy";
  return "";
}

function botToken(ctx) {
  const source = botTokenSource(ctx);
  if (source === "env") return String(ctx.TG_BOT_TOKEN).trim();
  if (source === "legacy") return ctx.getLegacyBotToken();
  return "";
}

// Может ли этот Telegram-пользователь публиковать в канале: создатель или администратор с правом публикации
const canPost = (member) => {
  const st = member?.ok ? member.result?.status : "";
  return st === "creator" || (st === "administrator" && member.result?.can_post_messages !== false);
};

/**
 * Права аккаунта на его канал прямо сейчас. Проверяется перед каждой операцией в канале (публикация,
 * тестовый пост, удаление): если привязанный Telegram аккаунта больше не администратор канала с правом
 * публикации, бот платформы от его имени в канал не пишет.
 * → { ok: true } | { ok: false, status, code, error }
 */
async function channelAccess(ctx, channelId = ctx.get("channel_id"), token = botToken(ctx)) {
  const owner = ctx.get("tg_owner_chat_id");
  if (!owner) {
    return { ok: false, status: 409, code: "TELEGRAM_NOT_LINKED", error: "Привяжите свой Telegram (раздел «Telegram»): бот проверяет, что вы администратор канала, перед каждой публикацией." };
  }
  let member;
  try {
    member = await ctx.tg("getChatMember", { chat_id: channelId, user_id: Number(owner) }, token);
  } catch (err) {
    return { ok: false, status: 502, code: "TELEGRAM_NETWORK_ERROR", error: "Telegram недоступен, права в канале не проверены: " + cleanError(err.message) };
  }
  if (canPost(member)) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: "TELEGRAM_CHANNEL_ACCESS_REVOKED",
    error: "Ваш привязанный Telegram больше не администратор этого канала с правом публикации: действие отменено.",
  };
}

// Сообщение в Telegram ограничено 4096 символами: оставляем место под заголовок и ссылку
const MAX_DRAFT_PREVIEW = 3500;

/**
 * Строка о замечаниях проверки точности: сколько и какие фразы.
 */
function reviewLine(p) {
  let issues = [];
  try {
    issues = JSON.parse(p.meta || "{}")?.check?.issues || [];
  } catch {}
  const quotes = issues.slice(0, 3).map((i) => `«${String(i.quote).slice(0, 60)}»`).join(", ");
  return `Требует проверки: замечаний ${issues.length || "есть"}${quotes ? " — " + quotes : ""}. Подробности в панели.`;
}

/**
 * Текст и кнопки сообщения-черновика для владельца.
 */
function draftMessage(p, ctx) {
  const text = String(p.text || "");
  let meta = null;
  try {
    meta = JSON.parse(p.meta || "null");
  } catch {}
  // Владелец видит пост так, как он уйдёт в канал: с подписью (дата коммитов, ссылка, хештеги)
  const full = withFooter(text, meta?.footer);
  const preview = full.length > MAX_DRAFT_PREVIEW
    ? full.slice(0, MAX_DRAFT_PREVIEW) + "…\n\n(текст сокращён, полностью — в панели)"
    : full;
  const kind = p.kind === "digest" ? "Дайджест" : "Черновик";
  // Пометка к черновику (например, про переписанную историю ветки)
  const note = p.error ? `\n\nВнимание: ${p.error}` : "";
  const review = p.needs_review ? `\n\n⚠️ ${reviewLine(p)}` : "";
  // Оформление как в канале: заголовок и подзаголовки жирным (смещения — после строки «Черновик #id»)
  const head = `${kind} #${p.id}\n\n`;
  const entities = entitiesOf(preview, { headline: !!meta?.headline, sections: !!meta?.sections })
    .map((e) => ({ ...e, offset: e.offset + head.length }));
  return {
    text: `${head}${preview}${note}${review}\n\nПанель: ${panelUrl(ctx)}`,
    ...(entities.length ? { entities } : {}),
    reply_markup: {
      inline_keyboard: [
        [
          // Непроверенный текст публикуется только после второго нажатия (pubc → подтверждение)
          { text: "Опубликовать", callback_data: `${p.needs_review ? "pubc" : "pub"}:${p.id}:${textHash(text)}` },
          { text: "Другой вариант", callback_data: `regen:${p.id}` },
        ],
        [{ text: "Отклонить", callback_data: `rej:${p.id}` }],
      ],
    },
  };
}

/**
 * Сообщение владельцу в личку. Ошибки отправки не роняют вызывающий код.
 */
async function notifyOwner(ctx, payload) {
  const ownerChatId = ctx.get("tg_owner_chat_id");
  const token = botToken(ctx);
  if (!ownerChatId || !token || typeof ctx.tg !== "function") return null;
  const body = typeof payload === "string" ? { text: payload } : payload;
  try {
    const r = await ctx.tg("sendMessage", { chat_id: ownerChatId, ...body }, token);
    if (!r?.ok) console.warn("Не удалось написать владельцу:", cleanError(r?.description));
    return r;
  } catch (err) {
    console.warn("Не удалось написать владельцу:", cleanError(err.message));
    return null;
  }
}

async function sendDraftToOwner(ctx, id) {
  const p = ctx.post(id);
  if (!p || p.status !== "draft") return null;
  return notifyOwner(ctx, draftMessage(p, ctx));
}

module.exports = {
  canPost,
  channelAccess,
  textHash,
  botToken,
  botTokenSource,
  publicBaseUrl,
  panelUrl,
  draftMessage,
  reviewLine,
  notifyOwner,
  sendDraftToOwner,
};
