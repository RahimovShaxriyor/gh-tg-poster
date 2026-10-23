const path = require("path");
const { createDatabase } = require("./lib/db");
const { gh, tg, deleteWebhook, ai, buildInput, sleep } = require("./lib/services");
const { publish, generate, check, getStatus } = require("./lib/poster");
const { createApp } = require("./lib/app");
const { cleanError } = require("./lib/crypto");
const { handleUpdate } = require("./lib/telegram-bot");

const PASS = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || PASS;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const PORT = process.env.PORT || 3000;

// Если запуск напрямую без пароля — завершаем с понятной ошибкой
if (require.main === module && !PASS) {
  console.error("Задай ADMIN_PASSWORD в .env");
  process.exit(1);
}
if (require.main === module && !process.env.SESSION_SECRET) {
  console.warn("Предупреждение: SESSION_SECRET не задан, cookie сессий подписываются паролем администратора.");
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
let nextPollAt = null;
function schedulePoll() {
  if (pollIntervalTimer) clearInterval(pollIntervalTimer);
  const ms = Math.max(1, Math.min(60, Number(dbBundle.get("poll_interval", "5")) || 5)) * 60 * 1000;
  nextPollAt = Date.now() + ms;
  pollIntervalTimer = setInterval(() => {
    nextPollAt = Date.now() + ms;
    check(false, ctx);
  }, ms);
}
ctx.schedulePoll = schedulePoll;
ctx.getNextPollAt = () => nextPollAt;

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
        try {
          await handleUpdate(u, ctx, token);
        } catch (err) {
          console.error("Ошибка обработки апдейта Telegram:", cleanError(err.message));
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
