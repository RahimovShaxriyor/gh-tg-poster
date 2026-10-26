// Тестовая база с аккаунтом: createDatabase + пользователь «owner» и его данные (forUser).
// Старые тесты писались для одного владельца: им достаточно данных одного аккаунта.
// Изоляцию аккаунтов друг от друга проверяет test/tenancy.test.js.
const crypto = require("crypto");
const { createDatabase } = require("../../lib/db");

const TEST_USERNAME = "owner";
const TEST_PASSWORD = "test-secret-pass-123";

// Хеш в формате lib/crypto.js (scrypt$N$r$p$соль$хеш), но синхронно: тестам так удобнее
function hashSync(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * База и аккаунт: { ...данные аккаунта, platform, userId }. Повторный вызов для того же файла базы
 * берёт существующий аккаунт.
 */
function tenantDb(dbPath = ":memory:", key = "test-key", { username = TEST_USERNAME, password = TEST_PASSWORD } = {}) {
  const platform = createDatabase(dbPath, key);
  const existing = platform.userByUsername(username);
  const id = existing ? existing.id : platform.createUser(username, hashSync(password));
  return platform.forUser(id);
}

// ===== CSRF для старых тестов =====
// Изменяющие запросы требуют x-csrf-token своей сессии. Старые тесты проверяют бизнес-логику, поэтому
// для запросов к локальному серверу с cookie сессии токен подставляется сам: он запоминается из ответа
// входа или регистрации. Саму защиту проверяют тесты, которые ходят через rawFetch.
const rawFetch = global.fetch;
const csrfBySid = new Map();
const sidOf = (cookie) => String(cookie || "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1] || null;

global.fetch = async function fetchWithCsrf(url, opts = {}) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url));
  if (local && opts.method && opts.method !== "GET" && opts.method !== "HEAD") {
    const headers = { ...(opts.headers || {}) };
    const sid = sidOf(headers.cookie || headers.Cookie);
    if (sid && csrfBySid.has(sid) && !Object.keys(headers).some((h) => h.toLowerCase() === "x-csrf-token")) {
      headers["x-csrf-token"] = csrfBySid.get(sid);
      opts = { ...opts, headers };
    }
  }
  const res = await rawFetch(url, opts);
  if (local && /\/api\/auth\/(login|register|change-password)$/.test(new URL(String(url)).pathname) && res.ok) {
    const sid = sidOf(res.headers.get("set-cookie"));
    const data = await res.clone().json().catch(() => ({}));
    if (sid && data.csrf) csrfBySid.set(sid, data.csrf);
  }
  return res;
};

/**
 * Вход через API: → { cookie: "sid=…", csrf, status }
 */
async function login(base, { username = TEST_USERNAME, password = TEST_PASSWORD, fetchFn = global.fetch } = {}) {
  const res = await fetchFn(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { cookie, csrf: data.csrf, status: res.status, data };
}

// Перед каждой операцией в канале сервер спрашивает Telegram (getChatMember), администратор ли привязанный
// Telegram аккаунта. Готовый к публикации аккаунт в тестах — администратор своего канала:
// обёртка отвечает так на getChatMember, остальные вызовы передаёт моку теста
const ADMIN_MEMBER = { ok: true, result: { status: "administrator", can_post_messages: true } };
const channelAdmin = (tg) => async (method, body, token) => (method === "getChatMember" ? ADMIN_MEMBER : tg(method, body, token));

module.exports = { TEST_USERNAME, TEST_PASSWORD, hashSync, tenantDb, login, rawFetch, channelAdmin, ADMIN_MEMBER };
