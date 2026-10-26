// Аккаунты публичной платформы: имя и пароль, серверные сессии, CSRF, ограничение частоты.
// Пароль хранится только хешем scrypt (lib/crypto.js), сессия — только sha256 токена (lib/db.js).
const crypto = require("crypto");
const { hashPassword, verifyPasswordHash } = require("./crypto");

const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 30 * 864e5; // 30 дней
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128; // длинный пароль — лишняя работа scrypt

// Имя: 3–32 символа, латиница, цифры, «_», «.», «-»; начинается с буквы или цифры
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
// Имена, которые легко принять за служебные
const RESERVED = new Set(["admin", "administrator", "root", "system", "support", "api", "auth", "login", "logout", "register", "owner", "moderator", "help", "null", "undefined", "gh-tg-poster", "telegram", "github"]);
// Самые частые пароли: от перебора по словарю их не спасает и длина
const COMMON = new Set(["1234567890", "12345678910", "0123456789", "qwertyuiop", "password123", "password1234", "1q2w3e4r5t", "qwerty1234", "iloveyou12", "administrator", "1111111111", "0000000000", "abcdefghij", "passw0rd123"]);

function checkUsername(raw) {
  const name = String(raw ?? "").trim();
  const norm = name.toLowerCase();
  if (!USERNAME_RE.test(norm)) {
    return { ok: false, error: "Имя: от 3 до 32 символов — латинские буквы, цифры, «_», «.», «-»; начинается с буквы или цифры." };
  }
  if (RESERVED.has(norm)) return { ok: false, error: "Это имя зарезервировано, выберите другое." };
  return { ok: true, username: name };
}

function checkPassword(password, username = "") {
  if (typeof password !== "string") return { ok: false, error: "Введите пароль." };
  if (password.length < PASSWORD_MIN) return { ok: false, error: `Пароль — не короче ${PASSWORD_MIN} символов.` };
  if (password.length > PASSWORD_MAX) return { ok: false, error: `Пароль — не длиннее ${PASSWORD_MAX} символов.` };
  const low = password.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(password)) return { ok: false, error: "Этот пароль слишком простой, придумайте другой." };
  if (username && low.includes(String(username).toLowerCase())) return { ok: false, error: "Пароль не должен содержать имя пользователя." };
  return { ok: true };
}

// ===== scrypt без перегрузки маленького сервера: не больше 2 вычислений одновременно =====
const HASH_SLOTS = 2;
let busy = 0;
const waiting = [];
async function withHashSlot(fn) {
  if (busy >= HASH_SLOTS) await new Promise((r) => waiting.push(r));
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
    waiting.shift()?.();
  }
}
const hash = (password) => withHashSlot(() => hashPassword(password));
const verify = (password, stored) => withHashSlot(() => verifyPasswordHash(password, stored));

// Хеш для несуществующего имени: проверка занимает то же время, и по ответу не понять, есть ли аккаунт
let dummyHash = null;
async function verifyOrDummy(password, stored) {
  if (stored) return verify(password, stored);
  dummyHash ||= await hash(crypto.randomBytes(16).toString("hex"));
  await verify(password, dummyHash);
  return { ok: false, needsRehash: false };
}

// ===== Cookie и CSRF =====
function readCookie(req, name = SESSION_COOKIE) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

const isSecureReq = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";

function sessionCookie(req, token, maxAgeMs = SESSION_TTL_MS) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${isSecureReq(req) ? "; Secure" : ""}`;
}
const clearCookies = (req) => [
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecureReq(req) ? "; Secure" : ""}`,
  // cookie прежней однопользовательской версии
  `s=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecureReq(req) ? "; Secure" : ""}`,
];

// CSRF-токен выводится из токена сессии: хранить не нужно, а с другой сессией он не сработает
const csrfToken = (secret, sessionToken) => crypto.createHmac("sha256", String(secret)).update("csrf:" + sessionToken).digest("base64url");
function csrfValid(secret, sessionToken, header) {
  if (!sessionToken || typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(csrfToken(secret, sessionToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ===== Ограничение частоты (в памяти процесса, окно фиксированной длины) =====
class RateLimiter {
  constructor({ limit, windowMs, max = 10000 }) {
    Object.assign(this, { limit, windowMs, max });
    this.hits = new Map(); // key -> { count, start }
  }
  entry(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) {
      e = { count: 0, start: now };
      if (this.hits.size >= this.max) this.prune(now);
      this.hits.set(key, e);
    }
    return e;
  }
  prune(now = Date.now()) {
    for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
    // Если окно ещё у всех открыто, а записей слишком много, — самые старые уходят
    while (this.hits.size >= this.max) this.hits.delete(this.hits.keys().next().value);
  }
  // Сколько минут ждать, если лимит исчерпан, иначе 0
  blocked(key) {
    const e = this.hits.get(key);
    if (!e || Date.now() - e.start >= this.windowMs || e.count < this.limit) return 0;
    return Math.max(1, Math.ceil((e.start + this.windowMs - Date.now()) / 60000));
  }
  hit(key) {
    this.entry(key).count++;
  }
  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  PASSWORD_MIN,
  PASSWORD_MAX,
  checkUsername,
  checkPassword,
  hash,
  verify,
  verifyOrDummy,
  readCookie,
  isSecureReq,
  sessionCookie,
  clearCookies,
  csrfToken,
  csrfValid,
  RateLimiter,
};
