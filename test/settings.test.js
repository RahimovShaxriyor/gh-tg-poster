const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { check } = require("../lib/poster");

describe("Настройки, прокси, дайджест", () => {
  const TEST_PASS = "settings-test-pass";
  let server;
  let baseUrl;
  let ctx;
  let cookie;
  const aiCalls = [];

  before(async () => {
    ctx = {
      ...createDatabase(":memory:", "settings-test-key"),
      ADMIN_PASSWORD: TEST_PASS,
      SESSION_SECRET: TEST_PASS,
      ai: async (input, force, opts) => {
        aiCalls.push(opts);
        return "Новый текст";
      },
    };
    server = http.createServer(createApp(ctx));
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const res = await login(TEST_PASS);
    cookie = res.headers.get("set-cookie").split(";")[0];
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function login(password, headers = {}) {
    return fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ password }),
    });
  }

  const saveSettings = (body) =>
    fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  it("POST /api/settings игнорирует ключи вне белого списка", async () => {
    ctx.setAdminPasswordHash("original-hash");
    ctx.set("last_sha", "sha-before");
    ctx.set("pending_head", "pending-before");
    ctx.set("tg_owner_chat_id", "111");
    ctx.set("github_installation_id", "");

    const res = await saveSettings({
      admin_password_hash: "attacker-hash",
      owner_id: "666",
      tg_owner_chat_id: "666",
      tg_owner_username: "@attacker",
      last_sha: "sha-after",
      pending_head: "pending-after",
      github_installation_id: "999",
      session_version: "1",
      tone: "разрешённое поле",
    });
    assert.equal(res.status, 200);

    assert.equal(ctx.getAdminPasswordHash(), "original-hash");
    assert.equal(ctx.getRaw("owner_id"), undefined);
    assert.equal(ctx.get("tg_owner_chat_id"), "111");
    assert.equal(ctx.get("tg_owner_username"), "");
    assert.equal(ctx.get("last_sha"), "sha-before");
    assert.equal(ctx.get("pending_head"), "pending-before");
    assert.equal(ctx.get("github_installation_id"), "");
    assert.equal(ctx.get("tone"), "разрешённое поле");

    ctx.setAdminPasswordHash("");
  });

  it("POST /api/settings отклоняет неверные значения и ничего не сохраняет", async () => {
    ctx.set("mode", "approve");
    ctx.set("poll_interval", "5");
    for (const bad of [
      { mode: "yolo" },
      { poll_interval: "0" },
      { poll_interval: "abc" },
      { debounce: "-1" },
      { digest_time: "25:00" },
      { digest_tz: "Mars/Olympus" },
      { repo: "../../etc" },
      { mode: "auto", poll_interval: "999" },
    ]) {
      const res = await saveSettings(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal(ctx.get("mode"), "approve", "частично валидный запрос не применяется");
    assert.equal(ctx.get("poll_interval"), "5");
  });

  it("POST /api/settings сохраняет debounce, digest_time и digest_tz из интерфейса", async () => {
    const res = await saveSettings({ debounce: "3", digest_time: "09:30", digest_tz: "Asia/Tashkent" });
    assert.equal(res.status, 200);
    const state = await (await fetch(`${baseUrl}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.settings.debounce, "3");
    assert.equal(state.settings.digest_time, "09:30");
    assert.equal(state.settings.digest_tz, "Asia/Tashkent");
  });

  it("/api/state отдаёт debounce_until и флаги kind/interrupted у постов", async () => {
    ctx.set("debounce", "10");
    ctx.set("pending_head", "abc");
    const pendingAt = Date.now();
    ctx.set("pending_at", pendingAt);
    ctx.db.prepare("delete from posts").run();
    ctx.db.prepare("insert into posts(status, text) values('sending', 't')").run();
    ctx.recoverStuckSending();

    const state = await (await fetch(`${baseUrl}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.debounce_until, new Date(pendingAt + 10 * 60000).toISOString());
    assert.equal(state.posts[0].status, "failed");
    assert.equal(state.posts[0].interrupted, 1);
    assert.equal(state.posts[0].kind, "commit");
    ctx.set("pending_head", "");
  });

  it("за прокси ограничение попыток считает по настоящему IP клиента, а не по подделанному X-Forwarded-For", async () => {
    // Caddy дописывает настоящий IP клиента в конец X-Forwarded-For.
    // Левую часть заголовка контролирует клиент и может менять при каждом запросе.
    const realIp = "203.0.113.5";
    for (let i = 1; i <= 5; i++) {
      const res = await login("wrong", { "x-forwarded-for": `198.51.100.${i}, ${realIp}` });
      assert.equal(res.status, 401);
    }
    const blocked = await login(TEST_PASS, { "x-forwarded-for": `198.51.100.77, ${realIp}` });
    assert.equal(blocked.status, 429, "подмена левой части XFF не обходит блокировку");

    const otherClient = await login("wrong", { "x-forwarded-for": "203.0.113.9" });
    assert.equal(otherClient.status, 401, "другой клиент не заблокирован");
  });

  it("дайджест передаёт ctx в buildInput и помечает пост как digest; regen дайджеста идёт с промптом дайджеста", async () => {
    const calls = [];
    const digestCtx = {
      ...createDatabase(":memory:", "k"),
      gh: async () =>
        new Response(
          JSON.stringify([
            { sha: "d2", commit: { message: "feat: x" }, parents: [{ sha: "d1" }] },
            { sha: "d1", commit: { message: "base" }, parents: [] },
          ]),
          { status: 200 }
        ),
      buildInput: async (...args) => {
        calls.push(args);
        return "input";
      },
      ai: async (input, force, opts) => {
        calls.push(["ai", opts.isDigest]);
        return "Дайджест";
      },
    };
    digestCtx.set("repo", "o/r");
    digestCtx.set("github_installation_id", "42");
    digestCtx.set("mode", "digest");
    digestCtx.set("last_sha", "d1");
    digestCtx.set("ai_key", "k");
    digestCtx.set("ai_model", "m");

    await check(true, digestCtx);
    const buildArgs = calls.find((c) => c[0] === "o/r");
    assert.equal(buildArgs[5], digestCtx, "ctx передан шестым аргументом");
    const post = digestCtx.getPosts({ limit: 1 })[0];
    assert.equal(post.kind, "digest");
    assert.deepEqual(calls.at(-1), ["ai", true]);
  });

  it("POST /api/posts/:id/regen для дайджеста использует промпт дайджеста, для обычного поста нет", async () => {
    ctx.set("ai_key", "k");
    ctx.set("ai_model", "m");
    ctx.set("mode", "approve");
    const digestId = ctx.db.prepare("insert into posts(status, input, kind) values('skipped', 'x', 'digest')").run().lastInsertRowid;
    const commitId = ctx.db.prepare("insert into posts(status, input) values('skipped', 'x')").run().lastInsertRowid;

    aiCalls.length = 0;
    for (const id of [digestId, commitId]) {
      const res = await fetch(`${baseUrl}/api/posts/${id}/regen`, { method: "POST", headers: { cookie } });
      assert.equal(res.status, 200);
    }
    assert.deepEqual(aiCalls.map((o) => o.isDigest), [true, false]);
  });
});
