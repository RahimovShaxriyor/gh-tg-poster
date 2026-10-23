const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { hashPassword, verifyPasswordHash, signCookie } = require("../lib/crypto");

describe("Пароль и сессии", () => {
  const TEST_PASS = "env-admin-password-777";
  let server;
  let baseUrl;
  let ctx;

  before(async () => {
    ctx = { ...createDatabase(":memory:", "sec-test-key"), ADMIN_PASSWORD: TEST_PASS, SESSION_SECRET: "sec-session-secret" };
    server = http.createServer(createApp(ctx));
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const login = (password) =>
    fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
  const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];
  const state = (cookie) => fetch(`${baseUrl}/api/state`, { headers: { cookie } });
  const changePassword = (cookie, current, next) =>
    fetch(`${baseUrl}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ current_password: current, new_password: next, confirm_password: next }),
    });

  it("hashPassword: scrypt с солью, разные хеши для одного пароля, проверка работает", async () => {
    const h1 = await hashPassword("secret-pass");
    const h2 = await hashPassword("secret-pass");
    assert.match(h1, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.notEqual(h1, h2);
    assert.deepEqual(await verifyPasswordHash("secret-pass", h1), { ok: true, needsRehash: false });
    assert.equal((await verifyPasswordHash("wrong", h1)).ok, false);
    assert.equal((await verifyPasswordHash("x", "garbage")).ok, false);
  });

  it("cookie старого формата (exp.signature) больше не принимается", async () => {
    const exp = Date.now() + 60000;
    const legacySig = crypto.createHmac("sha256", "sec-session-secret").update(String(exp)).digest("hex");
    const res = await state(`s=${exp}.${legacySig}`);
    assert.equal(res.status, 401);
  });

  it("cookie с подписью от другой версии сессии отклоняется", async () => {
    const exp = Date.now() + 60000;
    const res = await state(`s=${exp}.999.${signCookie(exp, "999", "sec-session-secret")}`);
    assert.equal(res.status, 401);
  });

  it("смена пароля: хеш в scrypt, старые сессии отозваны, текущий браузер получает новую cookie", async () => {
    const cookieA = cookieOf(await login(TEST_PASS));
    const cookieB = cookieOf(await login(TEST_PASS));
    assert.equal((await state(cookieA)).status, 200);
    assert.equal((await state(cookieB)).status, 200);

    const res = await changePassword(cookieA, TEST_PASS, "new-pass-123456");
    assert.equal(res.status, 200);
    const cookieA2 = cookieOf(res);

    assert.match(ctx.getAdminPasswordHash(), /^scrypt\$/);
    assert.equal((await state(cookieA)).status, 401, "старая cookie того же браузера отозвана");
    assert.equal((await state(cookieB)).status, 401, "сессия на другом устройстве отозвана");
    assert.equal((await state(cookieA2)).status, 200, "новая cookie работает");

    assert.equal((await login(TEST_PASS)).status, 401);
    assert.equal((await login("new-pass-123456")).status, 200);
  });

  it("старый sha256-хеш пароля принимается один раз и пересчитывается в scrypt", async () => {
    const legacy = crypto.createHash("sha256").update("legacy-pass-1").digest("hex");
    ctx.setAdminPasswordHash(legacy);

    assert.equal((await login("wrong-pass")).status, 401);
    assert.equal(ctx.getAdminPasswordHash(), legacy, "при неудачном входе хеш не трогаем");

    assert.equal((await login("legacy-pass-1")).status, 200);
    assert.match(ctx.getAdminPasswordHash(), /^scrypt\$/);
    assert.equal((await login("legacy-pass-1")).status, 200);
  });
});
