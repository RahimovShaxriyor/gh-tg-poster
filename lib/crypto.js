const crypto = require("crypto");

/**
 * Очистка текста от секретов (токены Telegram, Bearer-токены) для безопасного логирования и вывода ошибок.
 */
function cleanError(err) {
  if (!err) return "";
  const msg = typeof err === "string" ? err : err.message || String(err);
  return msg
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[СКРЫТО]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [СКРЫТО]")
    .replace(/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/gi, "[СКРЫТО]")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "[СКРЫТО]");
}

/**
 * Вычисление 32-байтного ключа из секретной строки.
 */
function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest();
}

/**
 * Шифрование значения алгоритмом AES-256-GCM.
 * Если ключ не задан, возвращает исходный текст.
 */
function encrypt(text, secret) {
  if (!secret || text === null || text === undefined) return text;
  const str = String(text);
  if (str === "" || str.startsWith("enc:v1:")) return str;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Расшифровка значения алгоритмом AES-256-GCM.
 * Если ключ не задан или значение не зашифровано, возвращает исходный текст.
 */
function decrypt(text, secret) {
  if (!text || typeof text !== "string") return text;
  if (!text.startsWith("enc:v1:")) return text;
  if (!secret) return null;
  try {
    const parts = text.split(":");
    if (parts.length !== 5) return null;
    const [, , ivHex, tagHex, dataHex] = parts;
    const key = deriveKey(secret);
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    return null;
  }
}

/**
 * Подпись cookie сессии: срок действия + версия сессии.
 * Версия хранится в БД и увеличивается при смене пароля, что отзывает все старые cookie.
 */
function signCookie(exp, version, secret) {
  return crypto.createHmac("sha256", secret).update(`${exp}.${version}`).digest("hex");
}

/**
 * Проверка подписи cookie (формат exp.version.signature), срока действия и версии сессии.
 */
function verifyCookie(cookieValue, secret, currentVersion) {
  if (!cookieValue || typeof cookieValue !== "string") return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [expStr, verStr, signature] = parts;
  if (!/^\d+$/.test(expStr) || !/^\d+$/.test(verStr) || !signature) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() >= exp) return false;
  if (verStr !== String(currentVersion)) return false;
  try {
    const expected = signCookie(expStr, verStr, secret);
    const bufA = Buffer.from(signature, "utf8");
    const bufB = Buffer.from(expected, "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Извлечение значения cookie `s` из заголовков запроса.
 */
function getSessionCookie(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  const match = raw.split(";").map((x) => x.trim()).find((x) => x.startsWith("s="));
  return match ? match.slice(2) : null;
}

/**
 * Проверка пароля за постоянное время для защиты от timing-атак.
 */
function verifyPassword(inputPassword, correctPassword) {
  const hash = (x) => crypto.createHash("sha256").update(String(x ?? "")).digest();
  return crypto.timingSafeEqual(hash(inputPassword), hash(correctPassword));
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

/**
 * Хеширование пароля scrypt с солью. Формат: scrypt$N$r$p$saltHex$hashHex.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Проверка пароля по сохранённому хешу за постоянное время.
 * Поддерживает старый формат (sha256 hex без соли): needsRehash=true означает,
 * что хеш надо пересчитать в scrypt.
 */
async function verifyPasswordHash(password, stored) {
  if (!stored || typeof stored !== "string") return { ok: false, needsRehash: false };

  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 6) return { ok: false, needsRehash: false };
    const [, n, r, p, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, "hex");
    const params = { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length };
    if (!params.keylen || !Number.isInteger(params.N)) return { ok: false, needsRehash: false };
    const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), params);
    const ok = crypto.timingSafeEqual(actual, expected);
    return { ok, needsRehash: ok && (params.N !== SCRYPT.N || params.r !== SCRYPT.r || params.p !== SCRYPT.p) };
  }

  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const actual = crypto.createHash("sha256").update(String(password ?? "")).digest();
    const ok = crypto.timingSafeEqual(actual, Buffer.from(stored, "hex"));
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

module.exports = {
  cleanError,
  deriveKey,
  encrypt,
  decrypt,
  signCookie,
  verifyCookie,
  getSessionCookie,
  verifyPassword,
  hashPassword,
  verifyPasswordHash,
};
