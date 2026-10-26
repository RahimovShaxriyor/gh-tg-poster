const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { gh, buildInput, ai, tg } = require("../lib/services");
const { TEST_PASSWORD, tenantDb } = require("./helpers/tenant");
const {
  appJwt,
  installationToken,
  clearInstallationTokenCache,
  verifyInstallation,
  issueState,
  consumeState,
  STATE_TTL_MS,
  getInstallationRepos,
  isAppConfigured,
} = require("../lib/github-app");

describe("GitHub App интеграция", () => {
  const TEST_PASS = "app-admin-secret-456";
  const TEST_KEY = "encryption-key-for-gh-app-tests";
  const TEST_APP_ID = "987654";
  const TEST_APP_SLUG = "my-test-gh-app";

  let server;
  let baseUrl;
  let testCtx;
  let originalFetch;
  let mockFetchHandler;

  // Генерируем реальную пару RSA ключей для RS256 подписи
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const privateKeyB64 = Buffer.from(privateKey, "utf8").toString("base64");

  before(async () => {
    originalFetch = global.fetch;
    global.fetch = async (...args) => {
      const url = String(args[0] || "");
      if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return originalFetch(...args);
      }
      if (mockFetchHandler) {
        return mockFetchHandler(...args);
      }
      return originalFetch(...args);
    };

    const dbBundle = tenantDb(":memory:", TEST_KEY);

    testCtx = {
      ...dbBundle,
      ADMIN_PASSWORD: TEST_PASS,
      SESSION_SECRET: TEST_PASS,
      ENCRYPTION_KEY: TEST_KEY,
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_SLUG: TEST_APP_SLUG,
      GITHUB_APP_PRIVATE_KEY_B64: privateKeyB64,
      gh: (path, token, ctx) => gh(path, token, ctx),
      tg: (m, body, token) => tg(m, body, token),
      ai: (input, force, opts) => ai(input, force, opts),
      buildInput: (repo, base, head, msgs, token, ctx) => buildInput(repo, base, head, msgs, token, ctx),
    };

    const app = createApp(testCtx);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    global.fetch = originalFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  afterEach(() => {
    mockFetchHandler = null;
    clearInstallationTokenCache();
  });

  async function getAuthCookie() {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
    });
    return res.headers.get("set-cookie").split(";")[0];
  }

  // 1. appJwt(): payload, заголовок, подпись RS256
  it("appJwt() генерирует корректный JWT с RS256 подписью и iat/exp", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = appJwt(TEST_APP_ID, privateKey);
    assert.ok(typeof token === "string");

    const parts = token.split(".");
    assert.equal(parts.length, 3);

    // Заголовок
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    assert.equal(header.alg, "RS256");
    assert.equal(header.typ, "JWT");

    // Payload
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    assert.equal(payload.iss, TEST_APP_ID);
    assert.ok(payload.iat <= nowSec);
    assert.ok(payload.iat >= nowSec - 70);
    assert.equal(payload.exp, payload.iat + 600); // 10 минут

    // Проверка RS256 подписи открытым ключом
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    const isValid = verifier.verify(publicKey, Buffer.from(parts[2], "base64url"));
    assert.equal(isValid, true);
  });

  // 2. installationToken(): выпуск токена, кэширование и обновление за 5 минут
  it("installationToken() запрашивает токен у GitHub, кэширует его и обновляет при необходимости", async () => {
    let fetchCalls = 0;
    mockFetchHandler = async (url, opts) => {
      if (url.includes("/access_tokens")) {
        fetchCalls++;
        assert.ok(opts.headers.Authorization.startsWith("Bearer "));
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_mocked_token_" + fetchCalls,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 час
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    // Первый запрос: должен вызвать fetch
    const t1 = await installationToken(12345, false, {
      appId: TEST_APP_ID,
      privateKey,
      fetch: global.fetch,
    });
    assert.equal(t1, "ghs_mocked_token_1");
    assert.equal(fetchCalls, 1);

    // Второй запрос: должен взять из кэша памяти без вызова fetch
    const t2 = await installationToken(12345, false, {
      appId: TEST_APP_ID,
      privateKey,
      fetch: global.fetch,
    });
    assert.equal(t2, "ghs_mocked_token_1");
    assert.equal(fetchCalls, 1);

    // Принудительное обновление forceRefresh: должен вызвать fetch заново
    const t3 = await installationToken(12345, true, {
      appId: TEST_APP_ID,
      privateKey,
      fetch: global.fetch,
    });
    assert.equal(t3, "ghs_mocked_token_2");
    assert.equal(fetchCalls, 2);
  });

  // 3. createAuthState() и verifyAuthState()
  it("state для GitHub: подпись HMAC, привязка к сессии и цели, срок 10 минут, одноразовость", () => {
    const secret = "test-session-secret";
    const opts = { purpose: "install", session: "сессия-А" };

    const state = issueState(testCtx, secret, opts);
    assert.equal(consumeState(testCtx, secret, state, { purpose: "install", session: "сессия-Б" }).ok, false, "чужая сессия");
    assert.equal(consumeState(testCtx, secret, state, { purpose: "create", session: "сессия-А" }).ok, false, "другая цель");
    assert.equal(consumeState(testCtx, "wrong-secret", state, opts).ok, false, "другой секрет");
    assert.equal(consumeState(testCtx, secret, state + "x", opts).ok, false, "подделка");
    assert.equal(consumeState(testCtx, secret, state, opts).ok, true, "верный state");
    const reused = consumeState(testCtx, secret, state, opts);
    assert.equal(reused.ok, false);
    assert.match(reused.error, /уже использована/);

    // Истёкший: выпущен «11 минут назад»
    const realNow = Date.now;
    Date.now = () => realNow() - STATE_TTL_MS - 60000;
    const old = issueState(testCtx, secret, opts);
    Date.now = realNow;
    const expired = consumeState(testCtx, secret, old, opts);
    assert.equal(expired.ok, false);
    assert.match(expired.error, /устарела/);
  });

  // 4. Маршрут GET /auth/github/start
  it("GET /auth/github/start требует сессии и перенаправляет на установку GitHub App со state", async () => {
    // Без сессии: 401
    const unauthRes = await fetch(`${baseUrl}/auth/github/start`, { redirect: "manual" });
    assert.equal(unauthRes.status, 401);

    // С сессией админа: 302 на https://github.com/apps/<slug>/installations/new?state=...
    const cookie = await getAuthCookie();
    const res = await fetch(`${baseUrl}/auth/github/start`, {
      headers: { cookie },
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.ok(location);
    assert.ok(location.startsWith(`https://github.com/apps/${TEST_APP_SLUG}/installations/new?state=`));

    // state подписан и привязан именно к этой сессии
    const stateParam = new URL(location).searchParams.get("state");
    const session = cookie.slice(cookie.indexOf("=") + 1);
    assert.equal(consumeState(testCtx, TEST_PASS, stateParam, { purpose: "install", session }).ok, true);
  });

  // 5. Маршрут GET /auth/github/setup
  it("GET /auth/github/setup проверяет state, валидирует установку на GitHub и сохраняет в настройки", async () => {
    const cookie = await getAuthCookie();
    const startRes = await fetch(`${baseUrl}/auth/github/start`, { headers: { cookie }, redirect: "manual" });
    const validState = new URL(startRes.headers.get("location")).searchParams.get("state");

    mockFetchHandler = async (url) => {
      if (url.includes("/app/installations/777888")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 777888,
            account: { login: "octocat-org" },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    // Ошибка: неверный state
    const badStateRes = await fetch(`${baseUrl}/auth/github/setup?installation_id=777888&setup_action=install&state=invalid`, {
      headers: { cookie, accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(badStateRes.status, 302);
    assert.ok(badStateRes.headers.get("location").includes("error="));
    assert.equal(testCtx.get("github_installation_id"), "");

    // Успех: валидный state и существующая установка
    const okRes = await fetch(`${baseUrl}/auth/github/setup?installation_id=777888&setup_action=install&state=${validState}`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(okRes.status, 302);
    const loc = okRes.headers.get("location");
    assert.ok(loc.includes("toast=github_connected"));
    assert.ok(loc.includes("#settings/github"));

    // Проверяем, что в БД сохранились installation_id и логин
    assert.equal(testCtx.get("github_installation_id"), "777888");
    assert.equal(testCtx.get("github_account_login"), "octocat-org");

    // Тот же state второй раз не принимается
    const reuseRes = await fetch(`${baseUrl}/auth/github/setup?installation_id=777888&setup_action=install&state=${validState}`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.match(decodeURIComponent(reuseRes.headers.get("location")), /уже использована/);
  });

  // 6. Список репозиториев GET /api/repos из /installation/repositories с пагинацией
  it("GET /api/repos при подключённом приложении опрашивает /installation/repositories с пагинацией", async () => {
    const cookie = await getAuthCookie();
    testCtx.set("github_installation_id", "777888");

    let pageCalls = [];
    mockFetchHandler = async (url, opts) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_install_test_tok",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      if (url.includes("/installation/repositories")) {
        const u = new URL(url);
        const page = u.searchParams.get("page");
        pageCalls.push(page);
        if (page === "1") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 3,
              repositories: [
                { full_name: "octocat-org/repo-one", default_branch: "main" },
                { full_name: "octocat-org/repo-two", default_branch: "dev" },
              ],
            }),
          };
        }
        if (page === "2") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_count: 3,
              repositories: [
                { full_name: "octocat-org/repo-three", default_branch: "master" },
              ],
            }),
          };
        }
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const res = await fetch(`${baseUrl}/api/repos`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const repos = await res.json();
    assert.equal(repos.length, 3);
    assert.deepEqual(repos, [
      { name: "octocat-org/repo-one", branch: "main" },
      { name: "octocat-org/repo-two", branch: "dev" },
      { name: "octocat-org/repo-three", branch: "master" },
    ]);
  });

  // 7. Отключение GitHub App POST /api/github/disconnect
  it("POST /api/github/disconnect сбрасывает сохранённый installation_id", async () => {
    const cookie = await getAuthCookie();
    testCtx.set("github_installation_id", "777888");
    testCtx.set("github_account_login", "octocat-org");

    const res = await fetch(`${baseUrl}/api/github/disconnect`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    assert.equal(testCtx.get("github_installation_id"), "");
    assert.equal(testCtx.get("github_account_login"), "");
  });

  // 8. Корректная обработка отозванного доступа в POST /api/test/github
  it("POST /api/test/github возвращает понятную ошибку и индикатор 'отозван', если доступ снят", async () => {
    const cookie = await getAuthCookie();
    testCtx.set("github_installation_id", "999000");
    testCtx.set("github_account_login", "revoked-user");

    mockFetchHandler = async (url) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ message: "Not Found" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const res = await fetch(`${baseUrl}/api/test/github`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("отозван"));

    // Проверяем, что в last_error записано предупреждение для индикатора панели
    const lastErr = testCtx.get("last_error");
    assert.ok(lastErr.includes("отозван"));
  });

  // 9. Функция gh() прозрачно использует токен установки
  it("gh() автоматически запрашивает токен установки, если github_installation_id задан", async () => {
    testCtx.set("github_installation_id", "555666");

    let usedAuthHeader = "";
    mockFetchHandler = async (url, opts) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_auto_installation_token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      if (url.includes("/repos/test/repo")) {
        usedAuthHeader = opts.headers?.Authorization || "";
        return {
          ok: true,
          status: 200,
          json: async () => ({ full_name: "test/repo" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const res = await gh("/repos/test/repo", null, testCtx);
    assert.equal(res.status, 200);
    assert.equal(usedAuthHeader, "Bearer ghs_auto_installation_token");
  });

  // 10. Пустой список репозиториев
  it("GET /api/repos корректно возвращает пустой массив при отсутствии репозиториев", async () => {
    const cookie = await getAuthCookie();
    testCtx.set("github_installation_id", "111222");

    mockFetchHandler = async (url) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_empty_tok",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      if (url.includes("/installation/repositories")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 0, repositories: [] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const res = await fetch(`${baseUrl}/api/repos`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  });

  // 11. Автоматический перевыпуск токена в gh() при 401 ответе
  it("gh() при получении 401 автоматически перевыпускает токен установки и повторяет запрос", async () => {
    testCtx.set("github_installation_id", "333444");

    let accessTokensCount = 0;
    let repoCallCount = 0;
    mockFetchHandler = async (url) => {
      if (url.includes("/access_tokens")) {
        accessTokensCount++;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: `ghs_token_v${accessTokensCount}`,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        };
      }
      if (url.includes("/repos/my/repo")) {
        repoCallCount++;
        if (repoCallCount === 1) {
          // Истёкший токен возвращает 401
          return { ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) };
        }
        // Второй запрос с новым токеном успешен
        return { ok: true, status: 200, json: async () => ({ id: 1, full_name: "my/repo" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const res = await gh("/repos/my/repo", null, testCtx);
    assert.equal(res.status, 200);
    assert.equal(accessTokensCount, 2);
    assert.equal(repoCallCount, 2);
  });

  // 12. check() переживает удаление установки GitHub App и фиксирует понятную ошибку
  it("check() при удалении приложения/установки не падает и устанавливает понятный last_error", async () => {
    const { check } = require("../lib/poster");
    testCtx.set("github_installation_id", "444555");
    testCtx.set("repo", "owner/project");
    testCtx.set("branch", "main");

    mockFetchHandler = async (url) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ message: "Not Found" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    // check() не должен выбрасывать необработанное исключение наружу
    await check(true, testCtx);

    const lastErr = testCtx.get("last_error");
    assert.ok(lastErr.includes("отозван"));
  });

  // 13. Приватный ключ приложения НЕ хранится в базе и НЕ отдаётся в API
  it("приватный ключ приложения не сохраняется в SQLite и не возвращается в /api/state", async () => {
    const cookie = await getAuthCookie();

    // 1. Проверяем БД (таблица kv)
    const rows = testCtx.db.prepare("select k, v from kv").all();
    for (const r of rows) {
      assert.ok(!r.v.includes("PRIVATE KEY"));
      assert.ok(!r.v.includes(privateKeyB64));
    }

    // 2. Проверяем /api/state
    const res = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const stateText = await res.text();
    assert.ok(!stateText.includes("PRIVATE KEY"));
    assert.ok(!stateText.includes(privateKeyB64));
  });
});
