const crypto = require("crypto");
const fs = require("fs");
const { cleanError } = require("./crypto");

const GITHUB_TIMEOUT_MS = 20000;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getAppPrivateKey(source = process.env) {
  if (!source) source = process.env;

  if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed.includes("PRIVATE KEY")) return trimmed;
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      if (decoded.includes("PRIVATE KEY")) return decoded;
    } catch {}
    if (fs.existsSync(trimmed)) {
      try {
        return fs.readFileSync(trimmed, "utf8");
      } catch {}
    }
    return null;
  }

  if (source.privateKey) {
    return getAppPrivateKey(source.privateKey);
  }
  const b64 = source.GITHUB_APP_PRIVATE_KEY_B64;
  if (b64) {
    try {
      const decoded = Buffer.from(b64.trim(), "base64").toString("utf8");
      if (decoded.includes("PRIVATE KEY")) return decoded;
    } catch {}
  }
  const keyPath = source.GITHUB_APP_PRIVATE_KEY_PATH;
  if (keyPath && fs.existsSync(keyPath)) {
    try {
      return fs.readFileSync(keyPath, "utf8");
    } catch {}
  }
  return null;
}

function isAppConfigured(env = process.env) {
  const appId = env?.GITHUB_APP_ID || process.env.GITHUB_APP_ID;
  const privateKey = getAppPrivateKey(env);
  return Boolean(appId && privateKey);
}

function appJwt(appId, privateKey) {
  const id = appId || process.env.GITHUB_APP_ID;
  const key = getAppPrivateKey(privateKey || process.env);
  if (!id || !key) {
    throw new Error("GitHub App не настроен: отсутствуют GITHUB_APP_ID или закрытый ключ");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: String(id),
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  const signature = signer.sign(key, "base64url");

  return `${data}.${signature}`;
}

const tokenCache = new Map(); // installationId -> { token, expiresAt }

function clearInstallationTokenCache() {
  tokenCache.clear();
}

async function installationToken(installationId, forceRefresh = false, options = {}) {
  const id = String(installationId);
  const now = Date.now();

  if (!forceRefresh && tokenCache.has(id)) {
    const cached = tokenCache.get(id);
    // Кэшируем до "за 5 минут до expires_at"
    if (now < cached.expiresAt - 5 * 60 * 1000) {
      return cached.token;
    }
  }

  const jwt = options.jwt || appJwt(options.appId, options.privateKey);
  const fetchFn = options.fetch || global.fetch;

  let res = await fetchFn(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-tg-web",
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  // При 401 перевыпускаем JWT и пробуем ещё раз
  if (res.status === 401 && !options.jwt) {
    const freshJwt = appJwt(options.appId, options.privateKey);
    res = await fetchFn(`https://api.github.com/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${freshJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "gh-tg-web",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  }

  if (!res.ok) {
    tokenCache.delete(id);
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new Error(`Доступ GitHub App отозван или установка #${id} не найдена (код ${res.status})`);
    }
    const errData = await res.json().catch(() => ({}));
    throw new Error(`Ошибка получения токена установки GitHub: ${cleanError(errData.message || res.status)}`);
  }

  const data = await res.json();
  const token = data.token;
  const expiresAt = new Date(data.expires_at).getTime();

  tokenCache.set(id, { token, expiresAt });
  return token;
}

// Проверка подлинности установки на GitHub
async function verifyInstallation(installationId, options = {}) {
  const id = String(installationId);
  const jwt = options.jwt || appJwt(options.appId, options.privateKey);
  const fetchFn = options.fetch || global.fetch;

  const res = await fetchFn(`https://api.github.com/app/installations/${id}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-tg-web",
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Установка #${id} не найдена в GitHub App (код ${res.status})`);
  }

  const data = await res.json();
  const accountLogin = data.account?.login || data.account?.name || "";
  return { ok: true, id, accountLogin, data };
}

// Создание и проверка HMAC state для OAuth/Setup
function createAuthState(secret) {
  const exp = Date.now() + 10 * 60 * 1000; // 10 минут
  const hmac = crypto.createHmac("sha256", String(secret)).update(String(exp)).digest("base64url");
  return `${exp}.${hmac}`;
}

function verifyAuthState(state, secret) {
  if (!state || typeof state !== "string") return false;
  const parts = state.split(".");
  if (parts.length !== 2) return false;
  const [expStr, signature] = parts;
  const exp = Number(expStr);
  if (isNaN(exp) || exp < Date.now()) return false;

  const expected = crypto.createHmac("sha256", String(secret)).update(String(exp)).digest("base64url");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// Загрузка репозиториев установки с пагинацией
async function getInstallationRepos(installationId, options = {}) {
  const fetchFn = options.fetch || global.fetch;
  const token = await installationToken(installationId, false, options);

  let repos = [];
  let page = 1;
  const perPage = 100;

  for (;;) {
    const res = await fetchFn(`https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "gh-tg-web",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });

    if (res.status === 401) {
      // Попробуем с принудительным обновлением токена
      const freshToken = await installationToken(installationId, true, options);
      const retryRes = await fetchFn(`https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`, {
        headers: {
          Authorization: `Bearer ${freshToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "gh-tg-web",
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (!retryRes.ok) {
        throw new Error(`Доступ к репозиториям установки #${installationId} отозван (код ${retryRes.status})`);
      }
      const data = await retryRes.json();
      const list = data.repositories || [];
      repos.push(...list);
      if (repos.length >= (data.total_count || 0) || list.length < perPage) break;
      page++;
      continue;
    }

    if (!res.ok) {
      throw new Error(`GitHub вернул ${res.status}: ошибка загрузки репозиториев установки`);
    }

    const data = await res.json();
    const list = data.repositories || [];
    repos.push(...list);

    const total = typeof data.total_count === "number" ? data.total_count : null;
    if (total !== null ? repos.length >= total : list.length < perPage) {
      break;
    }
    if (list.length === 0) break;
    page++;
    if (page > 10) break; // Защита от бесконечного цикла
  }

  return repos.map((r) => ({
    name: r.full_name,
    branch: r.default_branch || "main",
  }));
}

module.exports = {
  base64url,
  getAppPrivateKey,
  isAppConfigured,
  appJwt,
  installationToken,
  clearInstallationTokenCache,
  verifyInstallation,
  createAuthState,
  verifyAuthState,
  getInstallationRepos,
};
