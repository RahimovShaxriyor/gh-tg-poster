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
 * Подпись временной метки для cookie сессии.
 */
function signCookie(timestamp, secret) {
  return crypto.createHmac("sha256", secret).update(String(timestamp)).digest("hex");
}

/**
 * Проверка подписи cookie и срока её действия.
 */
function verifyCookie(cookieValue, secret) {
  if (!cookieValue || typeof cookieValue !== "string") return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return false;
  const [expStr, signature] = parts;
  if (!expStr || !signature || !/^\d+$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() >= exp) return false;
  try {
    const expected = signCookie(expStr, secret);
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

module.exports = {
  cleanError,
  deriveKey,
  encrypt,
  decrypt,
  signCookie,
  verifyCookie,
  getSessionCookie,
  verifyPassword,
};
