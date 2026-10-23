const crypto = require("crypto");
const { cleanError } = require("./crypto");
const { publish } = require("./poster");

const OWNER_CODE_TTL_MS = 15 * 60 * 1000;

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

/**
 * Обработка одного апдейта Telegram (my_chat_member, личные сообщения, callback-кнопки).
 */
async function handleUpdate(u, ctx, token) {
  const tg = (method, body) => ctx.tg(method, body, token);

  // 1. Привязка канала: только если канал ещё не задан и бота добавил админом сам владелец.
  //    Иначе любой, кто добавит бота в свой канал, получал бы ваши анонсы.
  const c = u.my_chat_member;
  if (c?.chat?.type === "channel" && c.new_chat_member?.status === "administrator" && !ctx.get("channel_id")) {
    const ownerChatId = String(ctx.get("tg_owner_chat_id") || "");
    if (ownerChatId && String(c.from?.id) === ownerChatId) {
      ctx.set("channel_id", c.chat.id);
      console.log("Канал Telegram привязан автоматически:", c.chat.id);
    } else {
      console.log("Бот добавлен в канал не владельцем (или владелец не привязан), канал не привязан:", c.chat.id);
    }
  }

  // 2. Личные сообщения: /start <код> привязывает владельца
  if (u.message && u.message.chat?.type === "private") {
    const text = (u.message.text || "").trim();
    if (text.startsWith("/start")) {
      const senderChatId = String(u.message.chat.id);
      const code = text.split(/\s+/)[1] || "";

      if (String(ctx.get("tg_owner_chat_id") || "") === senderChatId) {
        await tg("sendMessage", {
          chat_id: senderChatId,
          text: "Вы уже привязаны как владелец бота. Уведомления включаются в настройках панели.",
        });
      } else if (checkOwnerCode(ctx, code)) {
        clearOwnerCode(ctx);
        const uname = u.message.from?.username
          ? "@" + u.message.from.username
          : u.message.from?.first_name || senderChatId;
        ctx.set("tg_owner_chat_id", senderChatId);
        ctx.set("tg_owner_username", uname);
        await tg("sendMessage", {
          chat_id: senderChatId,
          text: `👋 Вы привязаны как владелец бота (${uname}). Сюда будут приходить черновики постов на согласование.`,
        });
      } else {
        await tg("sendMessage", {
          chat_id: senderChatId,
          text: "Чтобы привязать бота, получите код в панели (Настройки → Telegram) и отправьте /start <код>.",
        });
      }
    }
  }

  // 3. Callback-запросы по кнопкам «Опубликовать» / «Отклонить»
  if (u.callback_query) {
    const cb = u.callback_query;
    const senderId = String(cb.from?.id);
    const ownerChatId = String(ctx.get("tg_owner_chat_id") || "");

    if (!ownerChatId || senderId !== ownerChatId) {
      await tg("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Действие запрещено: вы не являетесь владельцем бота.",
        show_alert: true,
      });
      return;
    }

    const data = String(cb.data || "");
    const editSource = async (suffix) => {
      if (cb.message?.message_id && cb.message?.chat?.id) {
        await tg("editMessageText", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: `${cb.message.text || ""}\n\n${suffix}`,
        });
      }
    };

    try {
      if (data.startsWith("pub:")) {
        await publish(data.slice(4), null, ctx);
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Пост опубликован в канал!" });
        await editSource("✅ Опубликован в канал.");
      } else if (data.startsWith("rej:")) {
        const res = ctx.db.prepare("UPDATE posts SET status='rejected' WHERE id=? AND status='draft'").run(data.slice(4));
        if (res.changes === 0) {
          await tg("answerCallbackQuery", {
            callback_query_id: cb.id,
            text: "Пост уже обработан или не в статусе черновика.",
            show_alert: true,
          });
        } else {
          await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Черновик отклонён." });
          await editSource("❌ Отклонён.");
        }
      }
    } catch (err) {
      await tg("answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "Ошибка: " + cleanError(err.message),
        show_alert: true,
      });
    }
  }
}

module.exports = {
  OWNER_CODE_TTL_MS,
  createOwnerCode,
  clearOwnerCode,
  checkOwnerCode,
  handleUpdate,
};
