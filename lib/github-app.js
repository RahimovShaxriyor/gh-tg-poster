const crypto = require("crypto");
const fs = require("fs");
const { cleanError } = require("./crypto");
const { publicBaseUrl } = require("./notify");

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

/**
 * Данные приложения GitHub: сначала созданные кнопкой в панели (хранятся в базе, ключ зашифрован),
 * затем переменные окружения GITHUB_APP_* как запасной вариант. Набор берётся целиком из одного места,
 * чтобы id одного приложения не смешался с ключом другого.
 */
function appCredentials(ctx) {
  const dbId = ctx?.get?.("github_app_id");
  if (dbId) {
    return {
      appId: dbId,
      slug: ctx.get("github_app_slug") || "",
      privateKey: ctx.get("github_app_pem") || null,
      baseUrl: ctx.get("github_app_base_url") || "",
      source: "db",
    };
  }
  const env = {
    GITHUB_APP_ID: ctx?.GITHUB_APP_ID || process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY_B64: ctx?.GITHUB_APP_PRIVATE_KEY_B64 || process.env.GITHUB_APP_PRIVATE_KEY_B64,
    GITHUB_APP_PRIVATE_KEY_PATH: ctx?.GITHUB_APP_PRIVATE_KEY_PATH || process.env.GITHUB_APP_PRIVATE_KEY_PATH,
  };
  const privateKey = env.GITHUB_APP_ID ? getAppPrivateKey(env) : null;
  if (env.GITHUB_APP_ID && privateKey) {
    return {
      appId: String(env.GITHUB_APP_ID),
      slug: ctx?.GITHUB_APP_SLUG || process.env.GITHUB_APP_SLUG || "",
      privateKey,
      baseUrl: "",
      source: "env",
    };
  }
  return { appId: null, slug: "", privateKey: null, baseUrl: "", source: null };
}

// Параметры для installationToken / verifyInstallation / getInstallationRepos
function appOptions(ctx) {
  const { appId, privateKey } = appCredentials(ctx);
  return { appId, privateKey, fetch: global.fetch };
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

// ===== state для переходов на GitHub и обратно =====
// Подписан HMAC, привязан к сессии администратора и к цели перехода, живёт 10 минут, одноразовый:
// одноразовость обеспечивает список ожидающих nonce в базе.
const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_KEY = "github_pending_states";
const MAX_PENDING = 20;

const sessionBinding = (sessionCookie) => crypto.createHash("sha256").update(String(sessionCookie || "")).digest("base64url");
const signState = (secret, purpose, exp, nonce, sessionCookie) =>
  crypto.createHmac("sha256", String(secret)).update([purpose, exp, nonce, sessionBinding(sessionCookie)].join(".")).digest("base64url");

function loadPending(ctx) {
  try {
    const data = JSON.parse(ctx.get(PENDING_KEY) || "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function savePending(ctx, pending) {
  const now = Date.now();
  const live = Object.entries(pending).filter(([, exp]) => exp > now).sort((a, b) => b[1] - a[1]).slice(0, MAX_PENDING);
  ctx.set(PENDING_KEY, JSON.stringify(Object.fromEntries(live)));
}

/**
 * Новый state для перехода на GitHub. purpose: "create" (создание приложения) или "install" (установка).
 */
function issueState(ctx, secret, { purpose, session }) {
  const exp = Date.now() + STATE_TTL_MS;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const pending = loadPending(ctx);
  pending[nonce] = exp;
  savePending(ctx, pending);
  return `${exp}.${nonce}.${signState(secret, purpose, exp, nonce, session)}`;
}

/**
 * Проверка и погашение state. Возвращает { ok: true } или { ok: false, error } с понятным текстом.
 */
function consumeState(ctx, secret, state, { purpose, session }) {
  const invalid = { ok: false, error: "Ссылка от GitHub недействительна: начните подключение заново из панели." };
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return invalid;
  const [expStr, nonce, signature] = parts;
  const expected = signState(secret, purpose, expStr, nonce, session);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return invalid;

  const pending = loadPending(ctx);
  const known = Object.prototype.hasOwnProperty.call(pending, nonce);
  delete pending[nonce];
  savePending(ctx, pending);
  if (!(Number(expStr) > Date.now())) {
    return { ok: false, error: "Ссылка от GitHub устарела (она действует 10 минут): нажмите кнопку в панели ещё раз." };
  }
  if (!known) return { ok: false, error: "Эта ссылка от GitHub уже использована: начните подключение заново из панели." };
  return { ok: true };
}

// ===== Создание приложения по манифесту =====
/**
 * Манифест приложения GitHub: только чтение содержимого выбранных репозиториев, без вебхука.
 * Имя на GitHub должно быть уникальным, поэтому к нему добавляется случайный суффикс.
 *
 * hook_attributes и callback_urls намеренно отсутствуют: коммиты мы опрашиваем сами, а GitHub
 * проверяет адрес вебхука на доступность из интернета и отклоняет манифест с localhost.
 * redirect_url и setup_url — адреса для браузера пользователя, GitHub к ним сам не обращается.
 * url — домашняя страница приложения, просто ссылка на странице приложения.
 */
function appManifest(baseUrl = publicBaseUrl(), suffix = crypto.randomBytes(3).toString("hex")) {
  return {
    name: `gh-tg-poster-${suffix}`,
    url: baseUrl,
    redirect_url: `${baseUrl}/auth/github/manifest`,
    setup_url: `${baseUrl}/auth/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read" },
    default_events: [],
  };
}

/**
 * Обмен одноразового кода из манифеста на данные приложения. Запрос без авторизации.
 * Возвращает только то, что нам нужно: id, slug и закрытый ключ. client_secret и webhook_secret отбрасываются.
 */
async function convertManifest(code, { fetch: fetchFn = global.fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(code || ""))) {
    throw new Error("GitHub вернул некорректный код. Нажмите «Подключить GitHub» ещё раз.");
  }
  let res;
  try {
    res = await fetchFn(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "gh-tg-web" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error("GitHub недоступен, приложение не создано. Попробуйте позже. (" + cleanError(err.message) + ")");
  }
  if (res.status === 404) {
    throw new Error("Код от GitHub просрочен или уже использован (он действует час). Нажмите «Подключить GitHub» ещё раз.");
  }
  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    const details = `${body.message || ""} ${JSON.stringify(body.errors || "")}`;
    if (/name/i.test(details) && /(taken|exists|already)/i.test(details)) {
      throw new Error("Имя приложения уже занято на GitHub. Нажмите «Подключить GitHub» ещё раз: будет выбрано другое имя.");
    }
    throw new Error("GitHub отклонил создание приложения: " + cleanError(body.message || "ошибка 422"));
  }
  if (res.status >= 500) throw new Error(`GitHub недоступен (код ${res.status}), приложение не создано. Попробуйте позже.`);
  if (!res.ok) throw new Error(`GitHub вернул ${res.status}, приложение не создано.`);

  const data = await res.json().catch(() => ({}));
  if (!data.id || !data.slug || !String(data.pem || "").includes("PRIVATE KEY")) {
    throw new Error("GitHub вернул неполные данные приложения. Нажмите «Подключить GitHub» ещё раз.");
  }
  return { id: String(data.id), slug: String(data.slug), pem: String(data.pem), owner: data.owner?.login || "" };
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
  appCredentials,
  appOptions,
  appJwt,
  installationToken,
  clearInstallationTokenCache,
  verifyInstallation,
  issueState,
  consumeState,
  appManifest,
  convertManifest,
  STATE_TTL_MS,
  getInstallationRepos,
};
