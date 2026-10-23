const crypto = require("crypto");
const { cleanError } = require("./crypto");

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
  const preview = text.length > MAX_DRAFT_PREVIEW
    ? text.slice(0, MAX_DRAFT_PREVIEW) + "…\n\n(текст сокращён, полностью — в панели)"
    : text;
  const kind = p.kind === "digest" ? "Дайджест" : "Черновик";
  // Пометка к черновику (например, про переписанную историю ветки)
  const note = p.error ? `\n\nВнимание: ${p.error}` : "";
  const review = p.needs_review ? `\n\n⚠️ ${reviewLine(p)}` : "";
  return {
    text: `${kind} #${p.id}\n\n${preview}${note}${review}\n\nПанель: ${panelUrl(ctx)}`,
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
