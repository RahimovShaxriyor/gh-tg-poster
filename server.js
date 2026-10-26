// Новые файлы (база, её журнал) доступны только владельцу процесса
process.umask(0o077);

const fs = require("fs");
const path = require("path");
const { createDatabase } = require("./lib/db");
const { gh, tg, deleteWebhook, ai, aiCall, buildInput, buildInputData, sleep } = require("./lib/services");
const { publish, generate, check, waitIdle } = require("./lib/poster");
const { createApp } = require("./lib/app");
const { cleanError } = require("./lib/crypto");
const { handleUpdate, registerCommands, refreshBotInfo } = require("./lib/telegram-bot");
const { botToken, botTokenSource } = require("./lib/notify");

const SECRET = process.env.SESSION_SECRET;
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
  for (const k of ["SESSION_SECRET", "ENCRYPTION_KEY"]) {
    if (process.env[k] && example[k] && process.env[k] === example[k]) {
      problems.push(`${k} совпадает с примером из .env.example: придумайте своё значение`);
    }
  }
  if (!ENCRYPTION_KEY) problems.push("Задай ENCRYPTION_KEY в .env: им шифруются ключи ИИ и токены GitHub пользователей (openssl rand -hex 32)");
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    problems.push("Задай SESSION_SECRET в .env: случайная строка не короче 32 символов (openssl rand -hex 32)");
  }
  if (process.env.ADMIN_PASSWORD) {
    console.warn("ADMIN_PASSWORD больше не используется: у каждого свой аккаунт. Данные прежней версии переносятся командой node scripts/claim-legacy.js.");
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

// Общие сервисы и настройки окружения. Данных аккаунта здесь нет: их даёт userCtx(id)
const ctx = {
  platform: dbBundle,
  SESSION_SECRET: SECRET,
  ENCRYPTION_KEY,
  // Регистрация открыта всем; REGISTRATION_OPEN=0 закрывает её (например, для личного сервера)
  REGISTRATION_OPEN: process.env.REGISTRATION_OPEN !== "0",
  REGISTRATION_LIMIT_PER_HOUR: Number(process.env.REGISTRATION_LIMIT_PER_HOUR) || 100,
  // Пределы для маленького сервера (необязательно, значения по умолчанию — в коде)
  MAX_USERS: Number(process.env.MAX_USERS) || 50,
  MAX_POSTS_PER_USER: Number(process.env.MAX_POSTS_PER_USER) || 1000,
  AI_TASKS_PER_HOUR: Number(process.env.AI_TASKS_PER_HOUR) || 10,
  AI_GLOBAL: Number(process.env.AI_MAX_CONCURRENT) || 2,
  AI_PER_USER: Number(process.env.AI_MAX_CONCURRENT_PER_USER) || 1,
  API_REQUESTS_PER_5MIN: Number(process.env.API_REQUESTS_PER_5MIN) || 600,
  REGISTRATION_PER_IP_PER_HOUR: Number(process.env.REGISTRATION_PER_IP_PER_HOUR) || 3,
  REGISTRATION_PER_IP_PER_DAY: Number(process.env.REGISTRATION_PER_IP_PER_DAY) || 5,
  JSON_BODY_LIMIT: process.env.JSON_BODY_LIMIT || "100kb",
  // Один бот на всю платформу: токен только из окружения, пользователям не передаётся
  TG_BOT_TOKEN: (process.env.TG_BOT_TOKEN || "").trim(),
  getLegacyBotToken: dbBundle.getLegacyBotToken,
  gh,
  tg,
  deleteWebhook,
  ai,
  aiCall,
  buildInput,
  buildInputData,
};
const userCtx = (userId) => ({ ...ctx, ...dbBundle.forUser(userId) });

// ===== Планировщик проверок GitHub =====
// Один таймер на весь сервер: раз в 30 секунд он смотрит, чьи проверки подошли, и ставит их в очередь.
// Одновременно идёт не больше CHECK_CONCURRENCY проверок; у каждого аккаунта своё расписание и состояние,
// ошибка одного аккаунта не мешает остальным.
const TICK_MS = 30 * 1000;
const CHECK_CONCURRENCY = 2;
let stopping = false;
const nextDue = new Map(); // userId → время следующей проверки
const queue = [];
const queued = new Set();
let running = 0;

// Не чаще MIN_POLL_MINUTES (по умолчанию 5): тысяча аккаунтов с интервалом 1 мин перегрузили бы сервер и GitHub API
const MIN_POLL_MINUTES = Math.max(1, Number(process.env.MIN_POLL_MINUTES) || 5);
const intervalMs = (uctx) => Math.max(MIN_POLL_MINUTES, Math.min(60, Number(uctx.get("poll_interval", "5")) || 5)) * 60 * 1000;

// После смены интервала в настройках: следующая проверка — через новый интервал
function schedulePoll(userId) {
  if (userId === undefined || userId === null) return;
  nextDue.set(Number(userId), Date.now() + intervalMs(userCtx(userId)));
}
ctx.schedulePoll = schedulePoll;
ctx.getNextPollAt = (userId) => nextDue.get(Number(userId)) || null;

function pump() {
  while (!stopping && running < CHECK_CONCURRENCY && queue.length) {
    const uid = queue.shift();
    running++;
    Promise.resolve()
      .then(() => check(false, userCtx(uid)))
      .catch((err) => console.error(`Проверка аккаунта #${uid} не удалась:`, cleanError(err?.message || err)))
      .finally(() => {
        running--;
        queued.delete(uid);
        pump();
      });
  }
}

let ticks = 0;
function tick() {
  if (stopping) return;
  const now = Date.now();
  try {
    for (const uid of dbBundle.usersWithRepo()) {
      // Первый раз — с небольшим сдвигом, чтобы после перезапуска аккаунты не проверялись разом
      if (!nextDue.has(uid)) nextDue.set(uid, now + 5000 + (uid % 60) * 1000);
      if (nextDue.get(uid) > now || queued.has(uid)) continue;
      nextDue.set(uid, now + intervalMs(userCtx(uid)));
      queued.add(uid);
      queue.push(uid);
    }
    // Раз в час — уборка истёкших и отозванных сессий
    if (++ticks % 120 === 0) dbBundle.purgeSessions();
  } catch (err) {
    console.error("Ошибка планировщика:", cleanError(err.message));
  }
  pump();
}
let schedulerTimer = null;

const app = createApp(ctx);

// Фоновый цикл Telegram: автоопределение канала, команды и кнопки владельца
let tgLoopRunning = false;
let lastWebhookDeletedToken = null;
const commandsRegisteredFor = new Set();

async function startTgLoop() {
  if (tgLoopRunning) return;
  tgLoopRunning = true;
  let offset = 0;

  while (!stopping) {
    try {
      const token = botToken(ctx);
      if (!token) {
        await sleep(5000);
        continue;
      }

      // Перед циклом вызываем deleteWebhook (если токен новый или при первом запуске)
      if (lastWebhookDeletedToken !== token) {
        await deleteWebhook(token);
        lastWebhookDeletedToken = token;
      }

      // Меню команд в личке каждого привязанного пользователя: один раз на пару «бот + чат»
      for (const { user_id: uid, chat_id: chat } of dbBundle.ownerChats()) {
        if (commandsRegisteredFor.has(token + "|" + chat)) continue;
        const reg = await registerCommands(userCtx(uid), token);
        if (reg?.ok) commandsRegisteredFor.add(token + "|" + chat);
        else {
          console.error("Не удалось зарегистрировать команды бота:", cleanError(reg?.description));
          break;
        }
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
  if (schedulerTimer) clearInterval(schedulerTimer);
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
  const tgSource = botTokenSource(ctx);
  if (!tgSource) {
    console.warn("TG_BOT_TOKEN не задан: бот выключен. Задайте токен от @BotFather в .env и перезапустите сервер.");
  } else {
    if (tgSource === "legacy") {
      console.warn("Используется старый токен бота из базы. Добавьте TG_BOT_TOKEN в .env и удалите старое значение в панели.");
    }
    refreshBotInfo(ctx).then((info) => {
      if (info?.error) console.error("Telegram getMe:", info.error);
      else if (info) console.log("Бот Telegram: @" + info.username);
    });
  }
  startTgLoop().catch((err) => console.error("Ошибка startTgLoop:", cleanError(err.message)));
  schedulerTimer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);

  process.on("unhandledRejection", (e) => console.error("Необработанная ошибка промиса:", cleanError(e?.message || e)));
  const server = app.listen(PORT, () => console.log("Готово: порт", PORT));
  process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
  process.on("SIGINT", () => shutdown(server, "SIGINT"));
}

module.exports = {
  app,
  ctx,
  userCtx,
  db: dbBundle.db,
  createDatabase,
  createApp,
  check: (userId, force) => check(force, userCtx(userId)),
  publish: (userId, id, text) => publish(id, text, userCtx(userId)),
  generate: (userId, id, force) => generate(id, force, userCtx(userId)),
  buildInput,
  ai,
  gh,
  tg,
  deleteWebhook,
  cleanError,
  schedulePoll,
  startTgLoop,
  tick,
};
