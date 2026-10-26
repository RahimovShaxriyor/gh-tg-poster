const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { appCredentials, appManifest, clearInstallationTokenCache, consumeState } = require("../lib/github-app");
const { publicBaseUrl } = require("../lib/notify");
const { TEST_PASSWORD, tenantDb } = require("./helpers/tenant");

const PASS = "manifest-test-password";
const BASE = "https://poster.example.org";

// Настоящая пара ключей: так можно проверить, что JWT подписан именно сохранённым ключом
const { privateKey: PEM, publicKey: PUBLIC_PEM } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const quietDb = (key) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return tenantDb(":memory:", key);
  } finally {
    console.warn = warn;
  }
};

// Значение настройки аккаунта как оно лежит в базе (секреты — зашифрованными)
const rawSetting = (ctx, k) => ctx.db.prepare("select v from user_settings where user_id=? and k=?").get(ctx.userId, k)?.v;

async function startServer(ctx) {
  const server = http.createServer(createApp(ctx));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return { server, base, cookie, session: cookie.slice(cookie.indexOf("=") + 1) };
}

describe("Подключение GitHub в одну кнопку (App Manifest)", () => {
  let originalFetch;
  let ghCalls;
  let ghHandler;
  let ctx;
  let srv;
  const savedEnv = {};

  before(() => {
    for (const k of ["PUBLIC_URL", "DOMAIN", "PORT", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY_B64", "GITHUB_APP_PRIVATE_KEY_PATH"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PUBLIC_URL = BASE;
    originalFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      if (String(url).startsWith("http://127.0.0.1")) return originalFetch(url, opts);
      ghCalls.push({ url: String(url), opts });
      return ghHandler(String(url), opts);
    };
  });

  after(() => {
    global.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    ghCalls = [];
    ghHandler = async () => new Response("{}", { status: 404 });
    clearInstallationTokenCache();
    if (srv) await new Promise((r) => srv.server.close(r));
    ctx = { ...quietDb("manifest-encryption-key"), ADMIN_PASSWORD: PASS, SESSION_SECRET: "s".repeat(40), ENCRYPTION_KEY: "manifest-encryption-key" };
    srv = await startServer(ctx);
  });

  after(async () => {
    if (srv) await new Promise((r) => srv.server.close(r));
  });

  const get = (path, cookie = srv.cookie) => fetch(srv.base + path, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const panelMessage = (res) => {
    const loc = new URL(res.headers.get("location"), "http://x");
    return { error: loc.searchParams.get("error"), toast: loc.searchParams.get("toast"), hash: loc.hash };
  };
  const createState = async () => {
    const page = await (await get("/auth/github/create")).text();
    const action = page.match(/action="([^"]+)"/)[1].replace(/&amp;/g, "&");
    return new URL(action).searchParams.get("state");
  };
  const conversionOk = (extra = {}) => async (url) => {
    if (url.includes("/app-manifests/")) {
      return new Response(JSON.stringify({
        id: 424242, slug: "gh-tg-poster-ab12cd", pem: PEM, owner: { login: "anna" },
        client_id: "Iv1.x", client_secret: "client-secret-value", webhook_secret: "webhook-secret-value", ...extra,
      }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };

  it("адрес панели: PUBLIC_URL, затем DOMAIN (https), затем localhost:PORT", () => {
    assert.equal(publicBaseUrl({ PUBLIC_URL: "https://a.example/", DOMAIN: "b.example" }), "https://a.example");
    assert.equal(publicBaseUrl({ DOMAIN: "b.example" }), "https://b.example");
    assert.equal(publicBaseUrl({ DOMAIN: "http://localhost:3000" }), "http://localhost:3000");
    assert.equal(publicBaseUrl({ PORT: "3999" }), "http://localhost:3999");
    assert.equal(publicBaseUrl({}), "http://localhost:3000");
  });

  it("все маршруты /auth/github/* закрыты без сессии", async () => {
    for (const path of ["/auth/github/create", "/auth/github/manifest?code=x&state=y", "/auth/github/start", "/auth/github/setup?installation_id=1"]) {
      const res = await get(path, null);
      assert.equal(res.status, 401, path);
    }
    assert.equal(ghCalls.length, 0);
  });

  it("страница создания: форма POST на github.com с манифестом, без inline-скриптов и стилей", async () => {
    const res = await get("/auth/github/create");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /form-action 'self' https:\/\/github\.com/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self';/);

    const html = await res.text();
    assert.match(html, /<form[^>]+method="post"[^>]+action="https:\/\/github\.com\/settings\/apps\/new\?state=[^"]+"/);
    assert.match(html, /data-auto="1"/);
    assert.match(html, /<script src="\/github-create\.js" defer><\/script>/);
    assert.equal(/<script>|<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, "inline-скрипт");
    assert.equal(/\sstyle=|\son[a-z]+=/i.test(html), false, "inline-стиль или обработчик");
    assert.match(html, /Продолжить на GitHub/);

    const manifest = JSON.parse(html.match(/name="manifest" value="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    assert.match(manifest.name, /^gh-tg-poster-[0-9a-f]{6}$/);
    assert.equal(manifest.url, BASE);
    assert.equal(manifest.redirect_url, `${BASE}/auth/github/manifest`);
    assert.equal(manifest.setup_url, `${BASE}/auth/github/setup`);
    assert.equal(manifest.setup_on_update, true);
    assert.equal(manifest.public, false);
    assert.deepEqual(manifest.default_permissions, { contents: "read", metadata: "read" });
    assert.deepEqual(manifest.default_events, []);
    assert.equal("hook_attributes" in manifest, false);
  });

  it("состав манифеста: без вебхука и callback-адресов, права только на чтение, адреса от BASE_URL", () => {
    for (const base of ["http://localhost:3000", "https://poster.example.org"]) {
      const m = appManifest(base, "abc123");
      assert.deepEqual(Object.keys(m).sort(), [
        "default_events", "default_permissions", "name", "public", "redirect_url", "setup_on_update", "setup_url", "url",
      ]);
      assert.equal("hook_attributes" in m, false);
      assert.equal("callback_urls" in m, false);
      assert.deepEqual(m.default_permissions, { contents: "read", metadata: "read" });
      assert.deepEqual(m.default_events, []);
      assert.equal(m.redirect_url, `${base}/auth/github/manifest`);
      assert.equal(m.setup_url, `${base}/auth/github/setup`);
      assert.equal(m.url, base);
      assert.equal(m.public, false);
      assert.equal(m.name, "gh-tg-poster-abc123");
      // Кроме домашней страницы и двух адресов для браузера, адресов в манифесте нет
      const urls = JSON.stringify(m).match(/https?:\/\/[^"]+/g);
      assert.deepEqual(urls.sort(), [base, `${base}/auth/github/manifest`, `${base}/auth/github/setup`].sort());
    }
  });

  it("без ENCRYPTION_KEY страница предупреждает и не отправляет форму сама", async () => {
    await new Promise((r) => srv.server.close(r));
    ctx = { ...quietDb(undefined), ADMIN_PASSWORD: PASS, SESSION_SECRET: "s".repeat(40) };
    srv = await startServer(ctx);
    const html = await (await get("/auth/github/create")).text();
    assert.match(html, /data-auto="0"/);
    assert.match(html, /без шифрования/);
  });

  it("код из манифеста: обмен без авторизации, ключ зашифрован, секреты не сохраняются, переход на установку", async () => {
    ctx.set("github_installation_id", "1"); // старая установка от прежнего приложения
    const state = await createState();
    ghHandler = conversionOk();
    const res = await get(`/auth/github/manifest?code=abc123&state=${encodeURIComponent(state)}`);

    const call = ghCalls.find((c) => c.url.includes("/app-manifests/"));
    assert.equal(call.url, "https://api.github.com/app-manifests/abc123/conversions");
    assert.equal(call.opts.method, "POST");
    assert.equal(Object.keys(call.opts.headers).some((h) => h.toLowerCase() === "authorization"), false);

    assert.equal(ctx.get("github_app_id"), "424242");
    assert.equal(ctx.get("github_app_slug"), "gh-tg-poster-ab12cd");
    assert.equal(ctx.get("github_app_base_url"), BASE);
    assert.ok(rawSetting(ctx, "github_app_pem").startsWith("enc:v1:"), "ключ в базе зашифрован");
    assert.equal(ctx.get("github_app_pem"), PEM);
    assert.equal(ctx.get("github_installation_id"), "", "старая установка забыта");
    const allValues = ctx.db.prepare("select v from kv").all().map((r) => r.v).join("\n");
    assert.equal(allValues.includes("client-secret-value"), false);
    assert.equal(allValues.includes("webhook-secret-value"), false);
    assert.equal(allValues.includes("PRIVATE KEY"), false);

    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, "https://github.com/apps/gh-tg-poster-ab12cd/installations/new");
    assert.equal(consumeState(ctx, "s".repeat(40), loc.searchParams.get("state"), { purpose: "install", session: srv.session }).ok, true);

    // Ключ не уходит через API
    const stateJson = await (await fetch(srv.base + "/api/state", { headers: { cookie: srv.cookie } })).text();
    assert.equal(stateJson.includes("PRIVATE KEY"), false);
    assert.equal(stateJson.includes(rawSetting(ctx, "github_app_pem")), false);
    const data = JSON.parse(stateJson);
    assert.equal(data.github_app_configured, true);
    assert.equal(data.github_app_slug, "gh-tg-poster-ab12cd");
    assert.equal(data.github_app_source, "db");
  });

  it("state манифеста: неверный, из другой сессии, повторный — понятные ошибки, GitHub не вызывается", async () => {
    ghHandler = conversionOk();
    const bad = panelMessage(await get("/auth/github/manifest?code=abc&state=nonsense"));
    assert.match(bad.error, /недействительна/);
    assert.equal(bad.hash, "#settings/github");

    const state = await createState();
    const other = await fetch(`${srv.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
    });
    // Другая сессия (другая cookie) не может воспользоваться чужим state
    await new Promise((r) => setTimeout(r, 5));
    const otherCookie = other.headers.get("set-cookie").split(";")[0];
    assert.notEqual(otherCookie, srv.cookie);
    const foreign = panelMessage(await get(`/auth/github/manifest?code=abc&state=${encodeURIComponent(state)}`, otherCookie));
    assert.match(foreign.error, /недействительна/);
    assert.equal(ghCalls.length, 0);

    const fresh = await createState();
    await get(`/auth/github/manifest?code=abc&state=${encodeURIComponent(fresh)}`);
    const again = panelMessage(await get(`/auth/github/manifest?code=abc&state=${encodeURIComponent(fresh)}`));
    assert.match(again.error, /уже использована/);
  });

  for (const [name, handler, expected] of [
    ["код просрочен (404)", async () => new Response("{}", { status: 404 }), /просрочен.*час/],
    ["имя занято (422)", async () => new Response(JSON.stringify({ message: "Validation Failed", errors: ["Name has already been taken"] }), { status: 422 }), /Имя приложения уже занято/],
    ["GitHub недоступен (сеть)", async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); }, /GitHub недоступен/],
    ["GitHub недоступен (502)", async () => new Response("{}", { status: 502 }), /GitHub недоступен \(код 502\)/],
  ]) {
    it(`ошибка обмена кода: ${name}`, async () => {
      const state = await createState();
      ghHandler = handler;
      const msg = panelMessage(await get(`/auth/github/manifest?code=abc&state=${encodeURIComponent(state)}`));
      assert.match(msg.error, expected);
      assert.equal(ctx.get("github_app_id"), "");
    });
  }

  it("создание отменено на GitHub (нет code)", async () => {
    const state = await createState();
    assert.match(panelMessage(await get(`/auth/github/manifest?state=${encodeURIComponent(state)}`)).error, /отменено/);
  });

  it("установка: JWT подписан сохранённым в базе ключом, установка сохраняется", async () => {
    const state = await createState();
    ghHandler = conversionOk();
    const toInstall = new URL((await get(`/auth/github/manifest?code=abc&state=${encodeURIComponent(state)}`)).headers.get("location"));

    let jwt = "";
    ghHandler = async (url, opts) => {
      if (url === "https://api.github.com/app/installations/5555") {
        jwt = opts.headers.Authorization.replace("Bearer ", "");
        return new Response(JSON.stringify({ id: 5555, account: { login: "anna" } }));
      }
      return new Response("{}", { status: 404 });
    };
    const res = await get(`/auth/github/setup?installation_id=5555&setup_action=install&state=${encodeURIComponent(toInstall.searchParams.get("state"))}`);
    assert.equal(panelMessage(res).toast, "github_connected");
    assert.equal(ctx.get("github_installation_id"), "5555");
    assert.equal(ctx.get("github_account_login"), "anna");

    const [h, p, sig] = jwt.split(".");
    assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "424242");
    assert.equal(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), PUBLIC_PEM, Buffer.from(sig, "base64url")), true);
  });

  it("установка отменена, запрос владельцу организации, изменение доступа без state", async () => {
    ctx.set("github_app_id", "1");
    ctx.set("github_app_slug", "s");
    ctx.set("github_app_pem", PEM);

    const start = async () => new URL((await get("/auth/github/start")).headers.get("location")).searchParams.get("state");
    assert.match(panelMessage(await get(`/auth/github/setup?state=${encodeURIComponent(await start())}`)).error, /отменили/);
    assert.match(panelMessage(await get(`/auth/github/setup?setup_action=request&state=${encodeURIComponent(await start())}`)).error, /владельцу организации/);

    ctx.set("github_installation_id", "77");
    assert.equal(panelMessage(await get("/auth/github/setup?installation_id=77&setup_action=update")).toast, "github_updated");
    assert.match(panelMessage(await get("/auth/github/setup?installation_id=78&setup_action=update")).error, /недействительна/);
    assert.equal(ctx.get("github_installation_id"), "77");
  });

  it("приложение уже есть: /create ведёт на выбор репозиториев, ?recreate=1 — создаёт новое", async () => {
    ctx.set("github_app_id", "1");
    ctx.set("github_app_slug", "old-app");
    ctx.set("github_app_pem", PEM);
    assert.equal((await get("/auth/github/create")).headers.get("location"), "/auth/github/start");
    const res = await get("/auth/github/create?recreate=1");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /github\.com\/settings\/apps\/new/);
  });

  it("данные из базы важнее переменных окружения; без базы — env", () => {
    const envCtx = { ...quietDb("k"), GITHUB_APP_ID: "111", GITHUB_APP_SLUG: "env-app", GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(PEM).toString("base64") };
    assert.deepEqual([appCredentials(envCtx).appId, appCredentials(envCtx).source, appCredentials(envCtx).slug], ["111", "env", "env-app"]);
    envCtx.set("github_app_id", "222");
    envCtx.set("github_app_slug", "db-app");
    envCtx.set("github_app_pem", PEM);
    assert.deepEqual([appCredentials(envCtx).appId, appCredentials(envCtx).source, appCredentials(envCtx).slug], ["222", "db", "db-app"]);
  });

  it("«Отключить» забывает установку и ключи; ключ нельзя записать через настройки", async () => {
    const post = (path, body) => fetch(srv.base + path, { method: "POST", headers: { cookie: srv.cookie, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    await post("/api/settings", { github_app_pem: "-----BEGIN PRIVATE KEY-----x", github_app_id: "999" });
    assert.equal(ctx.get("github_app_pem"), "");
    assert.equal(ctx.get("github_app_id"), "");

    for (const [k, v] of Object.entries({ github_app_id: "1", github_app_slug: "s", github_app_pem: PEM, github_installation_id: "5", github_account_login: "anna" })) ctx.set(k, v);
    const res = await post("/api/github/disconnect");
    assert.match((await res.json()).message, /github\.com\/settings\/apps/);
    for (const k of ["github_app_id", "github_app_slug", "github_app_pem", "github_installation_id", "github_account_login"]) {
      assert.equal(ctx.get(k), "", k);
    }
    assert.equal(appCredentials(ctx).source, null);
  });
});
