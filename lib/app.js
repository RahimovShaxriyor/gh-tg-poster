const express = require("express");
const path = require("path");
const crypto = require("crypto");
const {
  cleanError,
  verifyCookie,
  signCookie,
  getSessionCookie,
  verifyPassword,
  hashPassword,
  verifyPasswordHash,
} = require("./crypto");
const { getStatus, publish, generate, check, variant } = require("./poster");
const { sleep, aiCall } = require("./services");
const { EXTRACT_SYSTEM, parseExtract, clean } = require("./pipeline");
const {
  appCredentials,
  appOptions,
  verifyInstallation,
  issueState,
  consumeState,
  appManifest,
  convertManifest,
  getInstallationRepos,
  clearInstallationTokenCache,
} = require("./github-app");
const { publicBaseUrl, botToken, botTokenSource } = require("./notify");
const { listModels, fallbackModels, ModelsError } = require("./ai-models");
const { listCommits, listBranches, getCommit, createPostFromCommits, listRepos, CommitsError } = require("./commits");
const { createOwnerCode, clearOwnerCode, unregisterCommands, refreshBotInfo, botInfo, checkChannel, OWNER_CODE_TTL_MS } = require("./telegram-bot");

const parseJson = (v) => {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};

// Образцы стиля: JSON-массив до 3 строк, каждая до 1500 символов (пусто — без образцов)
function isStyleSamples(v) {
  if (v === "") return true;
  try {
    const list = JSON.parse(v);
    return Array.isArray(list) && list.length <= 3 && list.every((x) => typeof x === "string" && x.length <= 1500);
  } catch {
    return false;
  }
}

const NOTE_MAX = 500;

/**
 * Пояснения автора из тела запроса: { post: "", commits: { sha: "" } }. Только коммиты поста,
 * каждое пояснение до 500 символов; пустые отбрасываются.
 */
function parseNotes(body, allowedShas) {
  const text = (v, what) => {
    const t = String(v ?? "").trim();
    if (t.length > NOTE_MAX) {
      const err = new Error(`Пояснение ${what} длиннее ${NOTE_MAX} символов`);
      err.status = 400;
      throw err;
    }
    return t;
  };
  const out = { post: text(body?.post, "к посту"), commits: {} };
  const list = body?.commits && typeof body.commits === "object" ? body.commits : {};
  for (const [sha, v] of Object.entries(list)) {
    const key = String(sha).toLowerCase();
    if (!allowedShas.has(key)) {
      const err = new Error("Пояснение к коммиту, которого нет в этом посте");
      err.status = 400;
      throw err;
    }
    const t = text(v, `к коммиту ${key.slice(0, 7)}`);
    if (t) out.commits[key] = t;
  }
  return out;
}

/**
 * Создание Express приложения с внедрением контекста (db, services, config).
 */
function createApp(ctx) {
  const app = express();
  app.disable("x-powered-by");
  const pass = ctx.ADMIN_PASSWORD;
  const secret = ctx.SESSION_SECRET || pass;

  // Доверие только обратному прокси из локальной/docker-сети (Caddy).
  // С `true` любой клиент мог бы подменить X-Forwarded-For и обойти ограничение попыток входа.
  app.set("trust proxy", "loopback, uniquelocal");

  const sessionVersion = () => (typeof ctx.getSessionVersion === "function" ? ctx.getSessionVersion() : "1");
  const isAuthed = (req) => verifyCookie(getSessionCookie(req), secret, sessionVersion());
  const isSecureReq = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
  const setSessionCookie = (req, res) => {
    const exp = Date.now() + 7 * 864e5; // 7 дней
    const ver = sessionVersion();
    res.setHeader(
      "Set-Cookie",
      `s=${exp}.${ver}.${signCookie(exp, ver, secret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${isSecureReq(req) ? "; Secure" : ""}`
    );
  };

  // Проверка пароля: сохранённый в БД хеш (после смены через панель) важнее ADMIN_PASSWORD.
  // Хеш старого формата (sha256) при успешном входе пересчитывается в scrypt.
  async function checkAdminPassword(input) {
    const stored = typeof ctx.getAdminPasswordHash === "function" && ctx.getAdminPasswordHash();
    if (!stored) return verifyPassword(input, pass);
    const { ok, needsRehash } = await verifyPasswordHash(input, stored);
    if (ok && needsRehash && typeof ctx.setAdminPasswordHash === "function") {
      ctx.setAdminPasswordHash(await hashPassword(input));
    }
    return ok;
  }

  // 1. Защитные HTTP-заголовки (без unsafe-inline для максимальной защиты)
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://github.com"
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Запросы, меняющие состояние, принимаются только со своей страницы. Cookie и так SameSite=Lax,
  // проверка Origin закрывает оставшиеся случаи (соседние поддомены, старые браузеры).
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost && originHost === req.headers.host) return next();
    res.status(403).json({ error: "Запрос с чужого сайта отклонён" });
  });

  app.use(express.json());
  // Статические файлы из папки public (app.css, app.js, иконки)
  app.use(express.static(path.join(__dirname, "..", "public")));

  // 2. Healthcheck для Docker и мониторинга
  app.get("/health", (req, res) => res.json({ ok: true }));

  // 3. Главная страница
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  // 4. Ограничение попыток входа (in-memory rate limiting)
  const loginAttempts = new Map(); // ip -> { count, firstAt, blockedUntil }

  function checkRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry) return { blocked: false };

    if (entry.blockedUntil && entry.blockedUntil > now) {
      const minutesLeft = Math.ceil((entry.blockedUntil - now) / 60000);
      return {
        blocked: true,
        error: `Слишком много неудачных попыток входа. Попробуйте снова через ${minutesLeft} мин.`,
      };
    }

    if (now - entry.firstAt > 10 * 60 * 1000) {
      loginAttempts.delete(ip);
      return { blocked: false };
    }

    return { blocked: false };
  }

  function recordFail(ip) {
    const now = Date.now();
    // Чистим устаревшие записи, чтобы Map не рос бесконечно
    for (const [key, e] of loginAttempts) {
      if (now - e.firstAt > 10 * 60 * 1000 && !(e.blockedUntil > now)) loginAttempts.delete(key);
    }
    let entry = loginAttempts.get(ip);
    if (!entry || now - entry.firstAt > 10 * 60 * 1000) {
      entry = { count: 1, firstAt: now, blockedUntil: 0 };
    } else {
      entry.count++;
    }
    if (entry.count >= 5) {
      entry.blockedUntil = now + 10 * 60 * 1000;
    }
    loginAttempts.set(ip, entry);
  }

  function recordSuccess(ip) {
    loginAttempts.delete(ip);
  }

  // 5. Авторизация и выход
  app.post("/login", async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const rate = checkRateLimit(ip);
    if (rate.blocked) {
      return res.status(429).json({ error: rate.error });
    }

    const inputPass = String(req.body?.password ?? "");
    const isOk = await checkAdminPassword(inputPass);

    if (!isOk) {
      recordFail(ip);
      await sleep(1000);
      return res.status(401).json({ error: "Неверный пароль" });
    }

    recordSuccess(ip);
    setSessionCookie(req, res);
    res.json({ ok: true });
  });

  // Выход только POST-запросом: GET-ссылку можно подсунуть со стороннего сайта
  app.post("/logout", (req, res) => {
    res.setHeader(
      "Set-Cookie",
      `s=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecureReq(req) ? "; Secure" : ""}`
    );
    res.json({ ok: true });
  });

  const requireAdminAuth = (req, res, next) => {
    if (isAuthed(req)) {
      return next();
    }
    if (req.accepts("html") && !req.accepts("json")) {
      return res.redirect("/");
    }
    res.status(401).json({ error: "auth" });
  };

  // ===== Подключение GitHub App: создание по манифесту, установка, возврат =====
  // Все маршруты — только с сессией администратора. Это переходы браузера, поэтому
  // и успех, и ошибка заканчиваются переходом в панель с сообщением.
  const backToPanel = (res, { error, toast }) =>
    res.redirect("/?" + (error ? "error=" + encodeURIComponent(error) : "toast=" + encodeURIComponent(toast)) + "#settings/github");
  const sessionOf = (req) => getSessionCookie(req);
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Шаг 1. Страница с формой манифеста: браузер отправляет её POST-запросом на github.com
  app.get("/auth/github/create", requireAdminAuth, (req, res) => {
    const creds = appCredentials(ctx);
    if (creds.appId && req.query.recreate !== "1") return res.redirect("/auth/github/start");

    const baseUrl = publicBaseUrl();
    const manifest = appManifest(baseUrl);
    const state = issueState(ctx, secret, { purpose: "create", session: sessionOf(req) });
    const encrypted = !!ctx.ENCRYPTION_KEY;
    const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;

    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Создание приложения GitHub</title>
  <link rel="stylesheet" href="/app.css">
  <script src="/github-create.js" defer></script>
</head>
<body>
  <div class="login">
    <form class="login-box" id="manifest-form" method="post" action="${escapeHtml(action)}" data-auto="${encrypted ? "1" : "0"}">
      <h1 class="login-title">Подключение GitHub</h1>
      <p class="login-note">GitHub попросит один раз подтвердить создание приложения «${escapeHtml(manifest.name)}». Права только на чтение выбранных репозиториев. Адрес панели: ${escapeHtml(baseUrl)}.</p>
      ${encrypted ? "" : '<p class="form-error">ENCRYPTION_KEY не задан: ключ приложения будет храниться в базе без шифрования. Задайте ключ в .env и перезапустите сервер, если это нежелательно.</p>'}
      <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
      <button type="submit" class="btn btn-primary btn-block">Продолжить на GitHub</button>
      <a class="btn btn-ghost btn-block" href="/#settings/github">Отмена</a>
    </form>
  </div>
</body>
</html>`);
  });

  // Шаг 2. GitHub вернул код: обмениваем его на id, slug и ключ приложения, затем ведём на установку
  app.get("/auth/github/manifest", requireAdminAuth, async (req, res) => {
    const checked = consumeState(ctx, secret, req.query.state, { purpose: "create", session: sessionOf(req) });
    if (!checked.ok) return backToPanel(res, { error: checked.error });
    if (!req.query.code) return backToPanel(res, { error: "Создание приложения на GitHub отменено." });

    let created;
    try {
      created = await convertManifest(String(req.query.code), { fetch: global.fetch });
    } catch (err) {
      return backToPanel(res, { error: err.message });
    }

    // Новое приложение — новая установка: старая привязка к нему не относится
    ctx.db.transaction(() => {
      ctx.set("github_app_id", created.id);
      ctx.set("github_app_slug", created.slug);
      ctx.set("github_app_pem", created.pem);
      ctx.set("github_app_base_url", publicBaseUrl());
      ctx.set("github_installation_id", "");
      ctx.set("github_account_login", "");
    })();
    clearInstallationTokenCache();

    const state = issueState(ctx, secret, { purpose: "install", session: sessionOf(req) });
    res.redirect(`https://github.com/apps/${encodeURIComponent(created.slug)}/installations/new?state=${encodeURIComponent(state)}`);
  });

  // Шаг 3. Выбор репозиториев: страница установки приложения на GitHub
  app.get("/auth/github/start", requireAdminAuth, (req, res) => {
    const creds = appCredentials(ctx);
    if (!creds.appId) return res.redirect("/auth/github/create");
    if (!creds.slug) return backToPanel(res, { error: "Не задан GITHUB_APP_SLUG: без него нельзя открыть страницу установки." });
    const state = issueState(ctx, secret, { purpose: "install", session: sessionOf(req) });
    res.redirect(`https://github.com/apps/${encodeURIComponent(creds.slug)}/installations/new?state=${encodeURIComponent(state)}`);
  });

  // Шаг 4. Возврат с GitHub после установки (или после изменения доступа к репозиториям)
  app.get("/auth/github/setup", requireAdminAuth, async (req, res) => {
    const { installation_id: installationId, setup_action: setupAction, state } = req.query;

    // Изменение доступа на стороне GitHub (setup_on_update) приходит без state: принимаем,
    // только если это уже подключённая у нас установка
    const known = ctx.get("github_installation_id");
    if (!state && setupAction === "update" && installationId && String(installationId) === known) {
      clearInstallationTokenCache();
      return backToPanel(res, { toast: "github_updated" });
    }

    const checked = consumeState(ctx, secret, state, { purpose: "install", session: sessionOf(req) });
    if (!checked.ok) return backToPanel(res, { error: checked.error });
    if (setupAction === "request") {
      return backToPanel(res, { error: "Запрос на установку отправлен владельцу организации. После одобрения нажмите «Выбрать репозитории»." });
    }
    if (!installationId) {
      return backToPanel(res, { error: "Установка не завершена: её отменили на GitHub. Нажмите «Выбрать репозитории», чтобы продолжить." });
    }
    if (!/^\d+$/.test(String(installationId))) return backToPanel(res, { error: "GitHub вернул некорректный номер установки." });

    try {
      const verified = await verifyInstallation(String(installationId), appOptions(ctx));
      ctx.set("github_installation_id", String(installationId));
      ctx.set("github_account_login", String(verified.accountLogin));
      ctx.set("last_error", "");
      clearInstallationTokenCache();
      backToPanel(res, { toast: "github_connected" });
    } catch (err) {
      backToPanel(res, { error: "Не удалось подтвердить установку на GitHub: " + cleanError(err.message) });
    }
  });

  // 6. Защита API-маршрутов сессионной cookie
  app.use("/api", (req, res, next) => {
    if (isAuthed(req)) {
      return next();
    }
    res.status(401).json({ error: "auth" });
  });

  // Отключение GitHub App
  // Отключение: забываем установку и ключи приложения, созданного панелью. Само приложение
  // остаётся на GitHub, удалить его можно только там.
  app.post("/api/github/disconnect", (req, res) => {
    const fromEnv = appCredentials(ctx).source === "env";
    ctx.db.transaction(() => {
      for (const k of ["github_installation_id", "github_account_login", "github_app_id", "github_app_slug", "github_app_pem", "github_app_base_url"]) {
        ctx.set(k, "");
      }
    })();
    clearInstallationTokenCache();
    res.json({
      ok: true,
      message: fromEnv
        ? "Установка отключена. Приложение задано в .env (GITHUB_APP_*): уберите эти переменные, чтобы панель его не использовала."
        : "GitHub отключён. Само приложение можно удалить на github.com/settings/apps.",
    });
  });

  // 7. Состояние панели управления
  app.get("/api/state", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const filter = String(req.query.filter || "all");

    const settings = {};
    for (const k of ctx.PLAIN) {
      settings[k] = ctx.get(k, ctx.DEF[k] ?? "");
    }
    let hasCorruptedSecrets = false;
    for (const k of ctx.SECRETS) {
      const isCorrupted = typeof ctx.isSecretCorrupted === "function" && ctx.isSecretCorrupted(k);
      if (isCorrupted) hasCorruptedSecrets = true;
      settings[k + "_set"] = !isCorrupted && !!ctx.get(k);
      settings[k + "_corrupted"] = isCorrupted;
    }
    if (hasCorruptedSecrets) {
      settings.secrets_corrupted = true;
      settings.secrets_message = "секреты не удалось расшифровать, введите их заново";
    }

    const status = getStatus(ctx);
    if (hasCorruptedSecrets && !status.last_error) {
      status.last_error = "секреты не удалось расшифровать, введите их заново";
    }

    const tzOffset = Math.max(-840, Math.min(840, Number(req.query.tzo) || 0));
    const counts = typeof ctx.getCounts === "function"
      ? ctx.getCounts(tzOffset)
      : { all: 0, total: 0, draft: 0, sent: 0, skipped: 0, failed: 0, rejected: 0, sent_today: 0 };
    const total = typeof ctx.countPosts === "function" ? ctx.countPosts(filter) : 0;
    const posts = typeof ctx.getPosts === "function" ? ctx.getPosts({ limit, offset, filter }) : [];
    const hasMore = offset + posts.length < total;

    const creds = appCredentials(ctx);
    const installationId = ctx.get("github_installation_id") || "";
    const accountLogin = ctx.get("github_account_login") || "";
    const hasManualToken = Boolean(settings.github_token_set);

    const debounceUntil = status.pending_head && status.pending_at
      ? new Date(status.pending_at + status.debounce * 60000).toISOString()
      : null;
    const nextPollAt = typeof ctx.getNextPollAt === "function" ? ctx.getNextPollAt() : null;
    const nextPollIn = nextPollAt ? Math.max(0, Math.ceil((nextPollAt - Date.now()) / 60000)) : null;

    res.json({
      settings,
      status,
      debounce_until: debounceUntil,
      next_poll_in: nextPollIn,
      counts,
      encryption_enabled: !!ctx.ENCRYPTION_KEY,
      domain: process.env.DOMAIN || "",
      posts,
      pagination: { total, limit, offset, filter, has_more: hasMore },
      // Ключ приложения в ответ не попадает никогда: только признаки
      github_app_configured: !!(creds.appId && creds.privateKey),
      github_app_id: creds.appId || "",
      github_app_slug: creds.slug,
      github_app_source: creds.source || "",
      github_app_base_url: creds.baseUrl,
      public_url: publicBaseUrl(),
      // Токен бота сюда не попадает: только источник и данные getMe
      telegram: telegramState(),
      github_installation_id: installationId,
      github_account_login: accountLogin,
      has_github_token: Boolean(installationId || hasManualToken),
    });
  });

  const BOT_NOT_CONFIGURED = "Бот не настроен: задайте TG_BOT_TOKEN в .env и перезапустите сервер";

  function telegramState() {
    const source = botTokenSource(ctx);
    const info = botInfo(ctx);
    return {
      configured: !!source,
      source,
      username: info?.username || "",
      bot_id: info?.id || null,
      error: info?.error || "",
      checked_at: info?.checked_at || null,
      legacy_token: typeof ctx.hasLegacyBotToken === "function" && ctx.hasLegacyBotToken(),
    };
  }

  // 8. Сохранение настроек: только ключи из белого списка, с проверкой значений
  const intInRange = (min, max) => (v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max;
  const isTimeZone = (v) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  };
  const VALIDATORS = {
    repo: (v) => v === "" || (/^[\w.-]+\/[\w.-]+$/.test(v) && v.split("/").every((part) => part !== "." && part !== "..")),
    branch: (v) => v !== "" && !/\s/.test(v),
    ai_provider: (v) => ["anthropic", "openai"].includes(v),
    mode: (v) => ["approve", "auto", "digest"].includes(v),
    debounce: intInRange(0, 120),
    poll_interval: intInRange(1, 60),
    digest_time: (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
    digest_tz: isTimeZone,
    tg_notify_drafts: (v) => v === "0" || v === "1",
    strict_check: (v) => v === "0" || v === "1",
    // Пусто — та же модель, что пишет пост
    verify_model: (v) => v === "" || /^[\w.:/@-]{1,100}$/.test(v),
    journal_days: (v) => ["30", "90", "180"].includes(v),
    audience: (v) => ["dev", "users", "mixed"].includes(v),
    voice: (v) => v.length <= 300,
    style_samples: isStyleSamples,
    banned_words: (v) => v.length <= 500,
    emoji: (v) => ["none", "few", "many"].includes(v),
    cta: (v) => ["question", "link", "none"].includes(v),
    variants: (v) => v === "1" || v === "3",
    paused: (v) => v === "0" || v === "1",
  };
  const FIELD_NAMES = {
    repo: "репозиторий (формат owner/name)",
    branch: "ветка",
    ai_provider: "провайдер ИИ",
    mode: "режим",
    debounce: "пауза после коммита (0–120 мин)",
    poll_interval: "интервал проверки (1–60 мин)",
    digest_time: "время дайджеста (ЧЧ:ММ)",
    digest_tz: "часовой пояс (например, Europe/Moscow)",
    tg_notify_drafts: "уведомления о черновиках",
    strict_check: "строгая проверка",
    verify_model: "модель для проверки",
    journal_days: "глубина журнала (30, 90 или 180 дней)",
    audience: "кто читает",
    voice: "голос (до 300 символов)",
    style_samples: "образцы стиля (до 3 постов, каждый до 1500 символов)",
    banned_words: "запретные слова (до 500 символов)",
    emoji: "эмодзи",
    cta: "призыв в конце",
    variants: "варианты подачи (1 или 3)",
    paused: "пауза проверки",
  };

  app.post("/api/settings", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const editable = ctx.EDITABLE || [];

    const updates = {};
    for (const k of editable) {
      if (!(k in body)) continue;
      const v = String(body[k] ?? "").trim();
      if (VALIDATORS[k] && !VALIDATORS[k](v)) {
        return res.status(400).json({ error: `Неверное значение: ${FIELD_NAMES[k] || k}` });
      }
      updates[k] = v;
    }

    const wasRepoBranch = ctx.get("repo") + "|" + ctx.get("branch", "main");
    const wasInterval = ctx.get("poll_interval", "5");

    for (const [k, v] of Object.entries(updates)) {
      ctx.set(k, v);
    }
    // Через настройки меняются только эти секреты. Токен бота — только в .env (TG_BOT_TOKEN),
    // ключ приложения GitHub — только через GitHub
    for (const k of ["github_token", "ai_key"]) {
      if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== "") {
        ctx.set(k, String(body[k]).trim());
      }
    }

    // Если изменился репозиторий или ветка — сбрасываем состояние
    const nowRepoBranch = ctx.get("repo") + "|" + ctx.get("branch", "main");
    if (wasRepoBranch !== nowRepoBranch) {
      ctx.set("last_sha", "");
      ctx.set("pending_head", "");
      ctx.set("pending_at", "");
      ctx.set("last_digest_sha", "");
    }

    // Если изменился интервал опроса — перенастраиваем таймер
    const nowInterval = ctx.get("poll_interval", "5");
    if (wasInterval !== nowInterval && typeof ctx.schedulePoll === "function") {
      ctx.schedulePoll();
    }

    res.json({ ok: true });
  });

  // 9. Смена пароля администратора через интерфейс
  app.post("/api/password", async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body || {};
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: "Новый пароль должен содержать минимум 6 символов" });
    }
    if (new_password !== confirm_password) {
      return res.status(400).json({ error: "Новые пароли не совпадают" });
    }

    const isOk = await checkAdminPassword(String(current_password || ""));
    if (!isOk) {
      return res.status(401).json({ error: "Текущий пароль указан неверно" });
    }

    if (typeof ctx.setAdminPasswordHash === "function") {
      ctx.setAdminPasswordHash(await hashPassword(String(new_password)));
    }
    // Отзываем все выданные сессии и сразу выдаём новую текущему браузеру
    if (typeof ctx.bumpSessionVersion === "function") {
      ctx.bumpSessionVersion();
    }
    setSessionCookie(req, res);
    res.json({ ok: true, message: "Пароль обновлён, остальные сессии завершены" });
  });

  // 10. Список репозиториев GitHub
  app.get("/api/repos", async (req, res) => {
    res.json(await listRepos(ctx));
  });

  // 11. Ручной запуск проверки
  app.post("/api/check", async (req, res) => {
    if (!ctx.get("repo")) return res.status(400).json({ error: "Не выбран репозиторий" });
    if (!ctx.get("github_token") && !ctx.get("github_installation_id")) {
      return res.status(400).json({ error: "GitHub не подключён" });
    }
    const result = await check(true, ctx);
    if (result.status === "busy") return res.status(409).json({ error: "Проверка уже идёт, подождите минуту" });
    if (result.status === "error") return res.status(400).json({ error: result.error });
    const messages = {
      first_run: "Репозиторий подключён. Посты появятся с новых коммитов",
      no_new: "Новых коммитов нет",
      created: "Новые коммиты найдены, пост подготовлен",
    };
    res.json({ ok: true, result: result.status, posts: result.posts, message: messages[result.status] || "Проверка выполнена" });
  });

  // 12. Кнопки проверки подключений
  app.post("/api/test/github", async (req, res) => {
    const instId = ctx.get("github_installation_id");
    const repo = ctx.get("repo");
    const startTime = Date.now();

    if (instId) {
      const login = ctx.get("github_account_login") || "аккаунт";
      try {
        const repos = await getInstallationRepos(instId, appOptions(ctx));
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        ctx.set("last_error", "");

        if (repo) {
          const found = repos.some((r) => r.name.toLowerCase() === repo.toLowerCase());
          if (!found) {
            return res.status(400).json({
              error: `Репозиторий «${repo}» не найден среди доступных репозиториев приложения (${login}). Проверьте настройки доступа на GitHub.`,
            });
          }
          return res.json({
            ok: true,
            user: login,
            repo,
            message: `Подключено через GitHub App (${login}), репозиторий «${repo}» доступен (ответ за ${duration} с)`,
          });
        }

        return res.json({
          ok: true,
          user: login,
          message: `Подключено через GitHub App (${login}), доступно репозиториев: ${repos.length} (ответ за ${duration} с)`,
        });
      } catch (err) {
        const msg = "Доступ GitHub App отозван, подключите заново (" + cleanError(err.message) + ")";
        ctx.set("last_error", "Доступ GitHub App отозван, подключите заново");
        return res.status(400).json({ error: msg });
      }
    }

    const token = ctx.get("github_token");
    if (!token) return res.status(400).json({ error: "Токен GitHub не заполнен" });

    const u = await ctx.gh("/user", token, ctx);
    if (!u.ok) return res.status(400).json({ error: "Неверный токен GitHub или нет доступа (код " + u.status + ")" });
    const user = await u.json();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (repo) {
      const rep = await ctx.gh(`/repos/${repo}`, token, ctx);
      if (!rep.ok) {
        return res.status(400).json({
          error: `Токен действителен (${user.login}), но репозиторий «${repo}» не найден или к нему нет доступа`,
        });
      }
      return res.json({
        ok: true,
        user: user.login,
        repo,
        message: `Подключено как ${user.login}, репозиторий «${repo}» доступен (ответ за ${duration} с)`,
      });
    }

    res.json({ ok: true, user: user.login, message: `Подключено как ${user.login}. Выберите репозиторий (ответ за ${duration} с)` });
  });

  // Проверка Telegram: getMe и права бота в канале — ровно то, что ответил Telegram
  app.post("/api/test/telegram", async (req, res) => {
    const r = await checkChannel(ctx);
    if (r.ok) return res.json({ ok: true, message: r.message });
    res.status(400).json({ error: r.message });
  });

  app.post("/api/test/reset-owner", async (req, res) => {
    // Убираем меню команд у прежнего владельца; ошибка Telegram сброс не блокирует
    const previousOwner = ctx.get("tg_owner_chat_id");
    const token = botToken(ctx);
    if (previousOwner && token && typeof ctx.tg === "function") {
      await unregisterCommands(ctx, token, previousOwner).catch(() => null);
    }
    ctx.set("tg_owner_chat_id", "");
    ctx.set("tg_owner_username", "");
    ctx.set("tg_owner_bound_at", "");
    clearOwnerCode(ctx);
    res.json({ ok: true, message: "Привязка владельца сброшена. Получите новый код привязки в панели." });
  });

  // Одноразовый код привязки владельца бота и ссылка t.me/<бот>?start=<код>
  app.post("/api/telegram/owner-code", async (req, res) => {
    if (!botToken(ctx)) return res.status(400).json({ error: BOT_NOT_CONFIGURED });
    const info = botInfo(ctx) || (await refreshBotInfo(ctx));
    if (!info?.username) return res.status(400).json({ error: info?.error || "Не удалось узнать имя бота: нажмите «Проверить»" });

    const { code, expiresAt } = createOwnerCode(ctx);
    res.json({
      ok: true,
      code,
      command: `/start ${code}`,
      username: info.username,
      link: `https://t.me/${info.username}?start=${code}`,
      ttl_minutes: Math.round(OWNER_CODE_TTL_MS / 60000),
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  // Удаление старого токена бота из базы (он раньше вводился в панели)
  app.post("/api/telegram/legacy-token/delete", (req, res) => {
    const removed = typeof ctx.deleteLegacyBotToken === "function" ? ctx.deleteLegacyBotToken() : 0;
    res.json({
      ok: true,
      message: removed
        ? botTokenSource(ctx) === "env" ? "Старый токен удалён из базы." : "Старый токен удалён из базы. Бот выключен, пока не задан TG_BOT_TOKEN в .env."
        : "Старого токена в базе нет.",
    });
  });

  // Провайдер и ключ для запроса к ИИ: из тела (несохранённые значения из формы) или сохранённые.
  // Ключ из тела используется только для этого запроса: не сохраняется и не логируется.
  function aiParams(body = {}) {
    const provider = ["anthropic", "openai"].includes(body.provider) ? body.provider : ctx.get("ai_provider", "anthropic");
    const typed = typeof body.key === "string" ? body.key.trim() : "";
    return { provider, key: typed || ctx.get("ai_key"), model: String(body.model || "").trim() || ctx.get("ai_model") };
  }
  const hideKey = (text, key) => (key ? String(text).split(key).join("[СКРЫТО]") : String(text));

  // Подсказки моделей: список у провайдера по ключу пользователя
  async function sendModels(req, res, params) {
    const { provider, key } = params;
    try {
      if (!key) throw new ModelsError("Сначала введите ключ ИИ и нажмите «Сохранить».");
      const result = await listModels(provider, key, { fetch: global.fetch, refresh: req.query.refresh === "1" || req.body?.refresh === true });
      res.json({ provider, ...result });
    } catch (err) {
      const message = err instanceof ModelsError ? err.message : "Не удалось получить список моделей: " + hideKey(cleanError(err.message), key);
      res.status(400).json({ error: message, provider, fallback: fallbackModels(provider) });
    }
  }
  app.get("/api/ai/models", (req, res) => sendModels(req, res, aiParams({ provider: req.query.provider })));
  app.post("/api/ai/models", (req, res) => sendModels(req, res, aiParams(req.body || {})));

  // Проверка ИИ выбранной моделью: время ответа и начало ответа или точная причина ошибки
  app.post("/api/test/ai", async (req, res) => {
    const { provider, key, model } = aiParams(req.body || {});
    if (!key) return res.status(400).json({ error: "Введите ключ ИИ." });
    if (!model) return res.status(400).json({ error: "Выберите или впишите модель." });

    const startTime = Date.now();
    try {
      const resp = await ctx.ai("Проверка связи. Ответь одним коротким предложением: связь есть.", true, {
        provider,
        key,
        model,
        tone: "",
        isDigest: false,
      });
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const text = hideKey(String(resp || "").replace(/\s+/g, " ").trim(), key);
      const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
      res.json({
        ok: true,
        message: `Ответ за ${duration} с (${provider}, ${model})` + (preview ? `: «${preview}»` : ", но текст пустой."),
      });
    } catch (err) {
      res.status(400).json({ error: hideKey(cleanError(err.message), key) });
    }
  });

  // ===== Журнал объявленного =====
  const journalDays = () => ctx.get("journal_days", "90");
  app.get("/api/memory", (req, res) => {
    const items = typeof ctx.getAnnounced === "function" ? ctx.getAnnounced(journalDays(), 500) : [];
    res.json({
      days: Number(journalDays()),
      total: items.length,
      items: items.slice(0, 30).map(({ id, post_id: postId, name, summary, created_at: createdAt }) => ({ id, post_id: postId, name, summary, created_at: createdAt })),
    });
  });

  // Старый пост в память: модель выписывает названия, человек правит их перед сохранением
  app.post("/api/memory/extract", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "Вставьте текст старого поста." });
    if (text.length > 4096) return res.status(400).json({ error: "Текст длиннее 4096 символов: это не похоже на пост из Telegram." });
    const { provider, key, model } = aiParams({});
    if (!key || !model) return res.status(400).json({ error: "Сначала заполните ключ и модель ИИ в настройках." });
    try {
      const raw = await (ctx.aiCall || aiCall)({ step: "extract", provider, key, model, temperature: 0, system: EXTRACT_SYSTEM, user: `<post>\n${clean(text)}\n</post>` });
      const items = parseExtract(raw);
      if (!items) return res.status(400).json({ error: "ИИ ответил не в формате JSON. Попробуйте ещё раз или впишите пункты вручную." });
      res.json({ ok: true, items });
    } catch (err) {
      res.status(400).json({ error: hideKey(cleanError(err.message), key) });
    }
  });

  app.post("/api/memory/items", (req, res) => {
    const list = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!list || !list.length) return res.status(400).json({ error: "Нет пунктов для сохранения." });
    if (list.length > 30) return res.status(400).json({ error: "За раз можно сохранить не больше 30 пунктов." });
    const items = [];
    for (const it of list) {
      const name = String(it?.name ?? "").replace(/\s+/g, " ").trim();
      const summary = String(it?.summary ?? "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      if (name.length > 100 || summary.length > 300) return res.status(400).json({ error: "Название — до 100 символов, описание — до 300." });
      items.push({ name, summary, shas: [] });
    }
    if (!items.length) return res.status(400).json({ error: "У пунктов нет названий." });
    ctx.addAnnounced(null, items);
    res.json({ ok: true, added: items.length });
  });

  // 13. Отправка тестового поста в канал
  app.post("/api/test/channel-post", async (req, res) => {
    const token = botToken(ctx);
    const channelId = ctx.get("channel_id");
    if (!token) return res.status(400).json({ error: BOT_NOT_CONFIGURED });
    if (!channelId) return res.status(400).json({ error: "Канал не указан в настройках" });

    const text = "🔔 Тестовое сообщение от gh-tg-web: проверка связи с Telegram-каналом прошла успешно.";
    const r = await ctx.tg("sendMessage", { chat_id: channelId, text }, token);
    if (!r.ok) {
      return res.status(400).json({ error: "Ошибка Telegram: " + cleanError(r.description) });
    }
    ctx.set("test_post_sent", "1");
    res.json({ ok: true, message: "Тестовое сообщение успешно опубликовано в канале." });
  });

  // ===== Вкладка «Коммиты»: ручной выбор коммитов =====
  // Репозиторий — только из сохранённых настроек; ветка и фильтры проверяются в lib/commits.js
  const commitsRoute = (handler) => async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (err) {
      if (!(err instanceof CommitsError)) throw err;
      const { message, status, code, retry_at: retryAt, duplicates } = err;
      res.status(status).json({ error: message, code, retry_at: retryAt, duplicates });
    }
  };
  const refreshOf = (req) => req.query.refresh === "1";

  app.get("/api/commits", commitsRoute((req) => listCommits(ctx, req.query, { refresh: refreshOf(req) })));
  app.get("/api/branches", commitsRoute((req) => listBranches(ctx, { refresh: refreshOf(req) })));
  // Подробности коммита для раскрытия строки: сообщение и файлы с +/−, без diff
  app.get("/api/commits/:sha", commitsRoute(async (req) => {
    const c = await getCommit(ctx, String(req.params.sha).toLowerCase(), { refresh: refreshOf(req) });
    return { sha: c.sha, message: c.message, files: c.files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions })) };
  }));
  app.post("/api/posts/from-commits", commitsRoute(async (req) => ({ ok: true, ...(await createPostFromCommits(ctx, req.body || {}, { generate })) })));

  // 14. Действия с постами
  app.post("/api/posts/:id/publish", async (req, res) => {
    const p = ctx.post(req.params.id);
    if (!p) throw new Error("Пост не найден");
    if (p.status === "sent") throw new Error("Этот пост уже отправлен в канал");
    if (p.status === "sending") throw new Error("Этот пост уже отправляется");
    if (!["draft", "failed"].includes(p.status)) throw new Error("Этот пост нельзя отправить");

    const text = String(req.body?.text ?? p.text ?? "").trim();
    if (!text) throw new Error("Текст поста не может быть пустым");
    // Непроверенные утверждения не блокируют публикацию, но требуют явного подтверждения
    if (p.needs_review && req.body?.confirm_unverified !== true) {
      return res.status(409).json({ error: "В тексте есть непроверенные утверждения: подтвердите публикацию", code: "needs_review" });
    }

    await publish(p.id, text, ctx);
    res.json({ ok: true });
  });

  // Сохранение правки черновика (панель сохраняет текст по ходу набора).
  // Пишем только в черновик: отправленный или генерируемый пост правка не затронет.
  app.post("/api/posts/:id/text", (req, res) => {
    const text = String(req.body?.text ?? "");
    if (text.length > 10000) throw new Error("Текст слишком длинный");
    const info = ctx.db.prepare("update posts set text=? where id=? and status='draft'").run(text, req.params.id);
    if (info.changes === 0) {
      const p = ctx.post(req.params.id);
      if (!p) throw new Error("Пост не найден");
      return res.status(409).json({ error: "Пост уже не черновик: правка не сохранена", status: p.status });
    }
    res.json({ ok: true });
  });

  // Пояснения автора к посту и к его коммитам (до 500 символов). Хранятся рядом с входом поста,
  // ИИ получает их отдельным блоком <author_note> как данные. Действуют со следующего варианта текста.
  app.post("/api/posts/:id/notes", (req, res) => {
    const p = ctx.post(req.params.id);
    if (!p) throw new Error("Пост не найден");
    if (["sent", "sending", "generating"].includes(p.status)) {
      return res.status(409).json({ error: p.status === "sent" ? "Пост уже отправлен: пояснения к нему не нужны" : "Пост сейчас в работе, повторите через минуту" });
    }
    const commits = new Set((parseJson(p.commits) || []).map((c) => String(c.sha).toLowerCase()));
    const notes = parseNotes(req.body, commits);
    ctx.db.prepare("update posts set notes=? where id=?").run(JSON.stringify(notes), p.id);
    res.json({ ok: true, notes });
  });

  app.post("/api/posts/:id/regen", async (req, res) => {
    const p = ctx.post(req.params.id);
    if (!p) throw new Error("Пост не найден");
    if (p.status === "sent") throw new Error("Нельзя изменить уже отправленный пост");
    if (p.status === "sending") throw new Error("Пост сейчас отправляется");

    const result = await generate(Number(req.params.id), true, ctx, p.kind === "digest", { notify: false });
    if (result.status === "failed") throw new Error(result.error || "Не удалось написать новый вариант");
    res.json({ ok: true, status: result.status });
  });

  // Варианты подачи: выбрать заход (готовый вариант — без нового текста), переписать с подсказкой
  const ANGLE_ID = /^a[1-3]$/;
  app.post("/api/posts/:id/variant", async (req, res) => {
    const angle = String(req.body?.angle || "");
    if (!ANGLE_ID.test(angle)) return res.status(400).json({ error: "Некорректный заход" });
    const r = await variant(Number(req.params.id), ctx, { action: "select", angle });
    res.json({ ok: true, ...r });
  });
  // Проверка ИИ невыбранного варианта по требованию (без перегенерации, вариант не выбирается)
  app.post("/api/posts/:id/variant/verify", async (req, res) => {
    const angle = String(req.body?.angle || "");
    if (!ANGLE_ID.test(angle)) return res.status(400).json({ error: "Некорректный заход" });
    const r = await variant(Number(req.params.id), ctx, { action: "verify", angle });
    res.json({ ok: true, ...r });
  });
  app.post("/api/posts/:id/rewrite", async (req, res) => {
    const hint = String(req.body?.hint || "");
    if (!["brighter", "simpler", "shorter", "benefit", "detailed"].includes(hint)) return res.status(400).json({ error: "Некорректная подсказка" });
    const r = await variant(Number(req.params.id), ctx, { action: "rewrite", hint });
    res.json({ ok: true, ...r });
  });

  app.post("/api/posts/:id/reject", (req, res) => {
    const info = ctx.db
      .prepare("update posts set status='rejected' where id=? and status not in ('sent','sending')")
      .run(req.params.id);
    if (info.changes === 0) {
      const p = ctx.post(req.params.id);
      if (p?.status === "sent") throw new Error("Нельзя отклонить уже отправленный пост");
      if (p?.status === "sending") throw new Error("Пост сейчас отправляется");
    }
    res.json({ ok: true });
  });

  // Удаление поста из Telegram-канала (deleteMessage)
  app.post("/api/posts/:id/delete-from-channel", async (req, res) => {
    const p = ctx.post(req.params.id);
    if (!p) throw new Error("Пост не найден");
    const ch = ctx.get("channel_id");
    const token = botToken(ctx);
    if (!token) throw new Error(BOT_NOT_CONFIGURED);
    if (!ch) throw new Error("Канал не задан в настройках Telegram");
    if (!p.tg_message_id) throw new Error("У этого поста нет идентификатора сообщения в Telegram");

    const r = await ctx.tg("deleteMessage", { chat_id: ch, message_id: p.tg_message_id }, token);
    if (!r.ok) {
      throw new Error("Не удалось удалить из Telegram: " + cleanError(r.description));
    }
    ctx.db.prepare("update posts set status='rejected', error='Удалён из Telegram-канала', tg_message_id=null where id=?").run(p.id);
    // Подписчики его больше не видят: из журнала объявленного тоже убираем
    if (typeof ctx.deleteAnnouncedForPost === "function") ctx.deleteAnnouncedForPost(p.id);
    res.json({ ok: true, message: "Пост успешно удалён из канала" });
  });

  const handleDeletePost = (req, res) => {
    if (ctx.post(req.params.id)?.status === "sending") throw new Error("Пост сейчас отправляется, удалить его можно чуть позже");
    const info = ctx.deletePost(req.params.id);
    if (info.changes === 0) throw new Error("Пост не найден");
    res.json({ ok: true });
  };

  app.delete("/api/posts/:id", handleDeletePost);
  app.post("/api/posts/:id/delete", handleDeletePost);

  // 15. Финальный обработчик ошибок Express 5
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 400;
    res.status(status).json({ error: cleanError(err.message || "Ошибка сервера") });
  });

  return app;
}

module.exports = {
  parseNotes,
  createApp,
};
