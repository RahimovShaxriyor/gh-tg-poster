const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { encrypt } = require("../lib/crypto");
const { botToken } = require("../lib/notify");
const { publish } = require("../lib/poster");
const { handleUpdate, createOwnerCode, OWNER_CODE_TTL_MS } = require("../lib/telegram-bot");

const PASS = "tg-token-test-password";
const ENV_TOKEN = "111111:ENV-token-AAAAAAAAAAAAAAAAAAAAAAA";
const LEGACY_TOKEN = "222222:LEGACY-token-BBBBBBBBBBBBBBBBBBB";
const KEY = "tg-token-test-encryption-key";

function quietDb() {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return createDatabase(":memory:", KEY);
  } finally {
    console.warn = warn;
  }
}

describe("Токен бота из TG_BOT_TOKEN", () => {
  let ctx;
  let calls;
  let tgReply;
  let server;
  let base;
  let cookie;

  beforeEach(async () => {
    calls = [];
    tgReply = (method) => (method === "getMe" ? { ok: true, result: { id: 777, username: "ForTestBot" } } : { ok: true, result: { message_id: 1 } });
    ctx = {
      ...quietDb(),
      ADMIN_PASSWORD: PASS,
      SESSION_SECRET: "s".repeat(40),
      ENCRYPTION_KEY: KEY,
      TG_BOT_TOKEN: ENV_TOKEN,
      tg: async (method, body, token) => {
        calls.push({ method, body, token });
        return tgReply(method, body);
      },
    };
    server = http.createServer(createApp(ctx));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASS }) });
    cookie = login.headers.get("set-cookie").split(";")[0];
  });

  afterEach(() => new Promise((r) => server.close(r)));

  const post = (p, body) =>
    fetch(base + p, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const state = async () => (await fetch(base + "/api/state", { headers: { cookie } })).text();

  it("сервер стартует без TG_BOT_TOKEN: панель работает, в Telegram ничего не уходит", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-notg-"));
    const log = path.join(work, "tg-calls.log");
    // Заглушка fetch: записывает любые обращения к Telegram
    fs.writeFileSync(path.join(work, "stub.js"), `
      const fs = require("fs");
      const real = global.fetch;
      global.fetch = async (url, opts) => {
        if (String(url).includes("api.telegram.org")) fs.appendFileSync(${JSON.stringify(log)}, String(url).replace(/bot[^/]+/, "bot*") + "\\n");
        if (String(url).startsWith("http://127.0.0.1")) return real(url, opts);
        return new Response("[]", { status: 200 });
      };`);
    const port = 3970 + Math.floor(Math.random() * 9);
    const env = { ...process.env, PORT: String(port), ADMIN_PASSWORD: PASS, SESSION_SECRET: "s".repeat(40), ENCRYPTION_KEY: KEY };
    delete env.TG_BOT_TOKEN;
    const child = spawn(process.execPath, ["-r", path.join(work, "stub.js"), path.join(__dirname, "..", "server.js")], { cwd: work, env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    try {
      let health = null;
      for (let i = 0; i < 50 && !health; i++) {
        await new Promise((r) => setTimeout(r, 100));
        health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status).catch(() => null);
      }
      assert.equal(health, 200);
      const l = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASS }) });
      const st = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie: l.headers.get("set-cookie").split(";")[0] } })).json();
      assert.equal(st.telegram.configured, false);
      await new Promise((r) => setTimeout(r, 1500));
      assert.match(output, /TG_BOT_TOKEN не задан: бот выключен/);
      assert.equal(fs.existsSync(log), false, "запросов к Telegram не было");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("/api/state не содержит ни токена из env, ни старого токена из базы", async () => {
    ctx.setRaw("tg_token", encrypt(LEGACY_TOKEN, KEY));
    await post("/api/test/telegram");
    const text = await state();
    for (const secret of [ENV_TOKEN, LEGACY_TOKEN, ENV_TOKEN.split(":")[1], LEGACY_TOKEN.split(":")[1]]) {
      assert.equal(text.includes(secret), false, secret);
    }
    const t = JSON.parse(text).telegram;
    assert.deepEqual([t.configured, t.source, t.username, t.legacy_token], [true, "env", "ForTestBot", true]);
  });

  it("токен бота нельзя записать через настройки", async () => {
    await post("/api/settings", { tg_token: LEGACY_TOKEN });
    assert.equal(ctx.getRaw("tg_token"), undefined);
  });

  it("миграция: без TG_BOT_TOKEN работает старый токен из базы, по кнопке он удаляется", async () => {
    ctx.TG_BOT_TOKEN = "";
    ctx.setRaw("tg_token", encrypt(LEGACY_TOKEN, KEY)); // так его хранила прежняя версия
    ctx.set("channel_id", "@chan");
    const id = Number(ctx.db.prepare("insert into posts(head,input,text,status) values('h','i','Текст','draft')").run().lastInsertRowid);

    let t = JSON.parse(await state()).telegram;
    assert.deepEqual([t.configured, t.source, t.legacy_token], [true, "legacy", true]);
    await publish(id, null, ctx);
    assert.equal(calls.find((c) => c.method === "sendMessage").token, LEGACY_TOKEN);

    const res = await (await post("/api/telegram/legacy-token/delete")).json();
    assert.match(res.message, /удалён/);
    assert.equal(ctx.getRaw("tg_token"), undefined);
    t = JSON.parse(await state()).telegram;
    assert.deepEqual([t.configured, t.source, t.legacy_token], [false, "", false]);
  });

  it("миграция: при заданном TG_BOT_TOKEN старое значение из базы игнорируется", async () => {
    ctx.setRaw("tg_token", LEGACY_TOKEN); // и открытым текстом тоже
    ctx.set("channel_id", "@chan");
    const id = Number(ctx.db.prepare("insert into posts(head,input,text,status) values('h','i','Текст','draft')").run().lastInsertRowid);
    await publish(id, null, ctx);
    assert.equal(calls.find((c) => c.method === "sendMessage").token, ENV_TOKEN);
    assert.equal(botToken(ctx), ENV_TOKEN);
  });

  it("без токена публикация отказывает и не трогает пост", async () => {
    ctx.TG_BOT_TOKEN = "";
    ctx.set("channel_id", "@chan");
    const id = Number(ctx.db.prepare("insert into posts(head,input,text,status) values('h','i','Текст','draft')").run().lastInsertRowid);
    await assert.rejects(() => publish(id, null, ctx), /Бот не настроен: задайте TG_BOT_TOKEN/);
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(ctx.post(id).interrupted, 0);
    assert.equal(calls.length, 0);
  });

  describe("проверка Telegram показывает ровно то, что ответил Telegram", () => {
    const check = async () => {
      const res = await post("/api/test/telegram");
      return { status: res.status, ...(await res.json()) };
    };

    it("без токена", async () => {
      ctx.TG_BOT_TOKEN = "";
      const r = await check();
      assert.equal(r.status, 400);
      assert.equal(r.error, "Бот не настроен: задайте TG_BOT_TOKEN в .env и перезапустите сервер");
      assert.equal(calls.length, 0);
    });

    it("Telegram не принял токен", async () => {
      tgReply = () => ({ ok: false, error_code: 401, description: "Unauthorized" });
      const r = await check();
      assert.equal(r.status, 400);
      assert.equal(r.error, "Telegram не принял токен: Unauthorized");
      assert.equal(JSON.parse(await state()).telegram.error, "Telegram не принял токен: Unauthorized");
    });

    it("канал не задан: имя бота и что сделать", async () => {
      const r = await check();
      assert.equal(r.status, 200);
      assert.match(r.message, /Бот @ForTestBot работает\. Канал не задан: добавьте @ForTestBot администратором канала с правом публикации/);
    });

    for (const [name, member, ok, expected] of [
      ["администратор с правом публикации", { ok: true, result: { status: "administrator", can_post_messages: true } }, true, /администратор канала @chan, может публиковать/],
      ["создатель канала", { ok: true, result: { status: "creator" } }, true, /может публиковать/],
      ["администратор без права публикации", { ok: true, result: { status: "administrator", can_post_messages: false } }, false, /без права публикации/],
      ["обычный участник", { ok: true, result: { status: "member" } }, false, /не администратор \(статус «member»\)/],
      ["канал не найден", { ok: false, description: "Bad Request: chat not found" }, false, /не дал доступа к каналу @chan: Bad Request: chat not found/],
    ]) {
      it(name, async () => {
        ctx.set("channel_id", "@chan");
        tgReply = (method) => (method === "getMe" ? { ok: true, result: { id: 777, username: "ForTestBot" } } : member);
        const r = await check();
        assert.equal(r.status, ok ? 200 : 400);
        assert.match(ok ? r.message : r.error, expected);
        assert.deepEqual(calls.find((c) => c.method === "getChatMember").body, { chat_id: "@chan", user_id: 777 });
      });
    }
  });

  describe("одноразовый код привязки владельца", () => {
    const start = (from, text) => handleUpdate({ message: { chat: { id: from, type: "private" }, from: { id: from, username: "u" + from }, text } }, ctx, ENV_TOKEN);

    it("ссылка t.me/<бот>?start=<код>, срок 10 минут", async () => {
      const res = await (await post("/api/telegram/owner-code")).json();
      assert.equal(OWNER_CODE_TTL_MS, 10 * 60 * 1000);
      assert.equal(res.ttl_minutes, 10);
      assert.equal(res.link, `https://t.me/ForTestBot?start=${res.code}`);
      const left = Date.parse(res.expires_at) - Date.now();
      assert.ok(left > 9 * 60 * 1000 && left <= 10 * 60 * 1000);
    });

    it("успех, повтор тем же кодом, чужой пользователь", async () => {
      const { code } = createOwnerCode(ctx);
      await start(500, `/start ${code}`);
      assert.equal(ctx.get("tg_owner_chat_id"), "500");
      assert.match(calls.find((c) => c.method === "sendMessage").body.text, /привязаны как владелец/);

      calls = [];
      await start(600, `/start ${code}`);
      assert.equal(ctx.get("tg_owner_chat_id"), "500", "код одноразовый");
      assert.deepEqual(calls, [], "чужому бот не отвечает");

      await start(600, "/start deadbeef0000");
      assert.equal(ctx.get("tg_owner_chat_id"), "500");
    });

    it("просроченный код не принимается", async () => {
      const { code } = createOwnerCode(ctx);
      ctx.set("tg_owner_code_exp", String(Date.now() - 1));
      await start(500, `/start ${code}`);
      assert.equal(ctx.get("tg_owner_chat_id"), "");
    });

    it("«Сменить»: новый владелец по новому коду, у прежнего снимается меню команд", async () => {
      ctx.set("tg_owner_chat_id", "500");
      const { code } = createOwnerCode(ctx);
      await start(700, `/start ${code}`);
      assert.equal(ctx.get("tg_owner_chat_id"), "700");
      const removed = calls.find((c) => c.method === "deleteMyCommands");
      assert.deepEqual(removed.body.scope, { type: "chat", chat_id: 500 });
      const added = calls.find((c) => c.method === "setMyCommands");
      assert.deepEqual(added.body.scope, { type: "chat", chat_id: 700 });
    });

    it("без токена код не выдаётся", async () => {
      ctx.TG_BOT_TOKEN = "";
      const res = await post("/api/telegram/owner-code");
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /TG_BOT_TOKEN/);
    });
  });
});
