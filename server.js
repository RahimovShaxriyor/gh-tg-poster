// Новые файлы (база, её журнал) доступны только владельцу процесса
process.umask(0o077);

const fs = require("fs");
const path = require("path");
const { createDatabase } = require("./lib/db");
const { gh, tg, deleteWebhook, ai, buildInput, sleep } = require("./lib/services");
const { publish, generate, check, waitIdle } = require("./lib/poster");
const { createApp } = require("./lib/app");
const { cleanError } = require("./lib/crypto");
const { handleUpdate, registerCommands } = require("./lib/telegram-bot");

const PASS = process.env.ADMIN_PASSWORD;
const SECRET = process.env.SESSION_SECRET || PASS;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const PORT = process.env.PORT || 3000;
const DATA_DIR = "data";

/**
 * Проверка переменных окружения при запуске. Значения-заглушки из .env.example известны всем,
 * поэтому с ними сервер не стартует.
 */
function checkEnv() {
  const problems = [];
  let example = {};
  try {
    example = Object.fromEntries(
      fs.readFileSync(path.join(__dirname, ".env.example"), "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );
  } catch {}
  for (const k of ["ADMIN_PASSWORD", "SESSION_SECRET", "ENCRYPTION_KEY"]) {
    if (process.env[k] && example[k] && process.env[k] === example[k]) {
      problems.push(`${k} совпадает с примером из .env.example: придумайте своё значение`);
    }
  }
  if (!PASS) problems.push("Задай ADMIN_PASSWORD в .env");
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    problems.push("Задай SESSION_SECRET в .env: случайная строка не короче 32 символов (openssl rand -hex 32)");
  }
  if (PASS && PASS.length < 12) {
    console.warn("Предупреждение: ADMIN_PASSWORD короче 12 символов, его легче подобрать.");
  }
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
}

/**
 * Папка data смонтирована с хоста. Если её владелец не совпадает с пользователем контейнера,
 * объясняем, как починить, вместо невнятной ошибки SQLite.
 */
function checkDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch {
    const uid = typeof process.getuid === "function" ? process.getuid() : "?";
    console.error(
      `Папка ${path.resolve(DATA_DIR)} недоступна для записи (процесс работает от uid ${uid}).\n` +
      `На сервере выполните в папке проекта: sudo chown -R ${uid}:${uid} data`
    );
    process.exit(1);
  }
}

if (require.main === module) {
  checkEnv();
  checkDataDir();
}

const dbBundle = createDatabase(path.join(DATA_DIR, "app.db"), ENCRYPTION_KEY);

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

let stopping = false;
let pollIntervalTimer = null;
let nextPollAt = null;
function schedulePoll() {
  if (pollIntervalTimer) clearInterval(pollIntervalTimer);
  const ms = Math.max(1, Math.min(60, Number(dbBundle.get("poll_interval", "5")) || 5)) * 60 * 1000;
  nextPollAt = Date.now() + ms;
  pollIntervalTimer = setInterval(() => {
    nextPollAt = Date.now() + ms;
    if (!stopping) check(false, ctx);
  }, ms);
}
ctx.schedulePoll = schedulePoll;
ctx.getNextPollAt = () => nextPollAt;

const app = createApp(ctx);

// Фоновый цикл Telegram: автоопределение канала, команды и кнопки владельца
let tgLoopRunning = false;
let lastWebhookDeletedToken = null;
let commandsRegisteredFor = null;

async function startTgLoop() {
  if (tgLoopRunning) return;
  tgLoopRunning = true;
  let offset = 0;

  while (!stopping) {
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

      // Меню команд в личке владельца: один раз на пару «бот + владелец»
      const owner = dbBundle.get("tg_owner_chat_id");
      if (owner && commandsRegisteredFor !== token + "|" + owner) {
        const reg = await registerCommands(ctx, token);
        if (reg?.ok) commandsRegisteredFor = token + "|" + owner;
        else console.error("Не удалось зарегистрировать команды бота:", cleanError(reg?.description));
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
      if (stopping) break;
      console.error("Ошибка в цикле Telegram:", cleanError(err.message));
      await sleep(10000);
    }
  }
}

/**
 * Корректная остановка: перестаём принимать запросы и запускать проверки, ждём текущие
 * отправку и генерацию (не дольше 25 с, docker-compose даёт 30 с), закрываем базу.
 */
function shutdown(server, signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Получен ${signal}, завершаю работу…`);
  if (pollIntervalTimer) clearInterval(pollIntervalTimer);
  server.close();
  waitIdle(25000).then((idle) => {
    if (!idle) console.warn("Не все операции успели завершиться: при старте они будут помечены как прерванные.");
    try {
      dbBundle.db.close();
    } catch {}
    process.exit(0);
  });
}

if (require.main === module) {
  startTgLoop().catch((err) => console.error("Ошибка startTgLoop:", cleanError(err.message)));
  setTimeout(() => {
    if (!stopping) check(false, ctx);
  }, 5000);
  schedulePoll();

  process.on("unhandledRejection", (e) => console.error("Необработанная ошибка промиса:", cleanError(e?.message || e)));
  const server = app.listen(PORT, () => console.log("Готово: порт", PORT));
  process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
  process.on("SIGINT", () => shutdown(server, "SIGINT"));
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
