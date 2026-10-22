const path = require("path");
const { createDatabase, PLAIN, SECRETS, DEF } = require("./lib/db");
const { gh, tg, deleteWebhook, ai, buildInput, sleep } = require("./lib/services");
const { publish, generate, check, getStatus } = require("./lib/poster");
const { createApp } = require("./lib/app");
const { cleanError } = require("./lib/crypto");

const PASS = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || PASS;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const PORT = process.env.PORT || 3000;

// Если запуск напрямую без пароля — завершаем с понятной ошибкой
if (require.main === module && !PASS) {
  console.error("Задай ADMIN_PASSWORD в .env");
  process.exit(1);
}

const dbBundle = createDatabase("data/app.db", ENCRYPTION_KEY);

const ctx = {
  ...dbBundle,
  ADMIN_PASSWORD: PASS,
  SESSION_SECRET: SECRET,
  ENCRYPTION_KEY,
  gh,
  tg,
  deleteWebhook,
  ai,
  buildInput,
  post: dbBundle.post,
  getPosts: dbBundle.getPosts,
  countPosts: dbBundle.countPosts,
  deletePost: dbBundle.deletePost,
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
  GITHUB_APP_PRIVATE_KEY_B64: process.env.GITHUB_APP_PRIVATE_KEY_B64,
  GITHUB_APP_PRIVATE_KEY_PATH: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
};

let pollIntervalTimer = null;
function schedulePoll() {
  if (pollIntervalTimer) clearInterval(pollIntervalTimer);
  const mins = Math.max(1, Math.min(60, Number(dbBundle.get("poll_interval", "5")) || 5));
  pollIntervalTimer = setInterval(() => check(false, ctx), mins * 60 * 1000);
}
ctx.schedulePoll = schedulePoll;

const app = createApp(ctx);

// Фоновый цикл Telegram для автоопределения канала, в который добавлен бот
let tgLoopRunning = false;
let lastWebhookDeletedToken = null;

async function startTgLoop() {
  if (tgLoopRunning) return;
  tgLoopRunning = true;
  let offset = 0;

  for (;;) {
    try {
      const token = dbBundle.get("tg_token");
      if (!token) {
        await sleep(5000);
        continue;
      }

      // Перед циклом вызываем deleteWebhook (если токен новый или при первом запуске)
      if (lastWebhookDeletedToken !== token) {
        await deleteWebhook(token);
        lastWebhookDeletedToken = token;
      }

      const r = await tg(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["my_chat_member", "message", "callback_query"] },
        token
      );
      if (!r.ok) {
        console.error("Telegram getUpdates ошибка:", cleanError(r.description));
        await sleep(10000);
        continue;
      }

      for (const u of r.result || []) {
        offset = u.update_id + 1;

        // 1. Привязка канала при добавлении бота администратором
        const c = u.my_chat_member;
        if (
          c?.chat?.type === "channel" &&
          c.new_chat_member?.status === "administrator" &&
          !dbBundle.get("channel_id")
        ) {
          dbBundle.set("channel_id", c.chat.id);
          console.log("Канал Telegram успешно привязан автоматически:", c.chat.id);
        }

        // 2. Личные сообщения боту (/start для привязки владельца)
        if (u.message && u.message.chat?.type === "private") {
          const text = (u.message.text || "").trim();
          if (text.startsWith("/start")) {
            const currentOwner = dbBundle.get("tg_owner_chat_id");
            const senderChatId = String(u.message.chat.id);
            if (!currentOwner) {
              dbBundle.set("tg_owner_chat_id", senderChatId);
              const uname = u.message.from?.username
                ? "@" + u.message.from.username
                : (u.message.from?.first_name || senderChatId);
              dbBundle.set("tg_owner_username", uname);
              await tg(
                "sendMessage",
                {
                  chat_id: senderChatId,
                  text: `👋 Вы успешно привязаны как владелец бота (${uname}). Сюда будут приходить уведомления о новых черновиках постов для согласования.`,
                },
                token
              );
            } else if (currentOwner === senderChatId) {
              await tg(
                "sendMessage",
                {
                  chat_id: senderChatId,
                  text: "Вы уже привязаны как владелец бота. Уведомления включены согласно настройкам панели.",
                },
                token
              );
            } else {
              await tg(
                "sendMessage",
                {
                  chat_id: senderChatId,
                  text: "Владелец бота уже назначен. Изменить владельца можно в настройках веб-панели.",
                },
                token
              );
            }
          }
        }

        // 3. Callback-запросы по кнопкам «Опубликовать» / «Отклонить»
        if (u.callback_query) {
          const cb = u.callback_query;
          const senderId = String(cb.from?.id);
          const ownerChatId = String(dbBundle.get("tg_owner_chat_id") || "");

          if (!ownerChatId || senderId !== ownerChatId) {
            await tg(
              "answerCallbackQuery",
              {
                callback_query_id: cb.id,
                text: "Действие запрещено: вы не являетесь владельцем бота.",
                show_alert: true,
              },
              token
            );
            continue;
          }

          const data = String(cb.data || "");
          if (data.startsWith("pub:")) {
            const postId = data.slice(4);
            try {
              await publish(postId, null, ctx);
              await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Пост опубликован в канал!" }, token);
              if (cb.message?.message_id && cb.message?.chat?.id) {
                await tg(
                  "editMessageText",
                  {
                    chat_id: cb.message.chat.id,
                    message_id: cb.message.message_id,
                    text: `${cb.message.text || ""}\n\n✅ Опубликован в канал.`,
                  },
                  token
                );
              }
            } catch (err) {
              await tg(
                "answerCallbackQuery",
                {
                  callback_query_id: cb.id,
                  text: "Ошибка: " + cleanError(err.message),
                  show_alert: true,
                },
                token
              );
            }
          } else if (data.startsWith("rej:")) {
            const postId = data.slice(4);
            try {
              const res = dbBundle.db.prepare("UPDATE posts SET status='rejected' WHERE id=? AND status='draft'").run(postId);
              if (res.changes === 0) {
                await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Пост уже обработан или не в статусе черновика.", show_alert: true }, token);
              } else {
                await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Черновик отклонён." }, token);
                if (cb.message?.message_id && cb.message?.chat?.id) {
                  await tg(
                    "editMessageText",
                    {
                      chat_id: cb.message.chat.id,
                      message_id: cb.message.message_id,
                      text: `${cb.message.text || ""}\n\n❌ Отклонён.`,
                    },
                    token
                  );
                }
              }
            } catch (err) {
              await tg(
                "answerCallbackQuery",
                {
                  callback_query_id: cb.id,
                  text: "Ошибка: " + cleanError(err.message),
                  show_alert: true,
                },
                token
              );
            }
          }
        }
      }
    } catch (err) {
      console.error("Ошибка в цикле Telegram:", cleanError(err.message));
      await sleep(10000);
    }
  }
}

if (require.main === module) {
  startTgLoop().catch((err) => console.error("Ошибка startTgLoop:", cleanError(err.message)));
  setTimeout(() => check(false, ctx), 5000);
  schedulePoll();

  process.on("unhandledRejection", (e) => console.error("Необработанная ошибка промиса:", cleanError(e?.message || e)));
  app.listen(PORT, () => console.log("Готово: порт", PORT));
}

module.exports = {
  app,
  ctx,
  db: dbBundle.db,
  get: dbBundle.get,
  set: dbBundle.set,
  post: dbBundle.post,
  createDatabase,
  createApp,
  check: (force) => check(force, ctx),
  publish: (id, text) => publish(id, text, ctx),
  generate: (id, force) => generate(id, force, ctx),
  buildInput,
  ai,
  gh,
  tg,
  deleteWebhook,
  cleanError,
  schedulePoll,
  startTgLoop,
};
