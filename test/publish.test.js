const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const services = require("../lib/services");

// Публикация из панели: POST /api/posts/:id/publish. Telegram везде подменён, реальных отправок нет.
describe("Публикация из панели: статусы HTTP и защита от дублей", () => {
  const PASS = "publish-pass-123";
  const TOKEN = "123456:SECRET-token";
  let server;
  let base;
  let ctx;
  let cookie;
  let calls;
  let reply;

  before(async () => {
    const { warn } = console;
    console.warn = () => {};
    ctx = { ...createDatabase(":memory:", "k"), ADMIN_PASSWORD: PASS, SESSION_SECRET: "s".repeat(40), TG_BOT_TOKEN: TOKEN };
    console.warn = warn;
    ctx.tg = async (method, body, token) => {
      calls.push({ method, body, token });
      return reply(method, body);
    };
    server = http.createServer(createApp(ctx));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASS }),
    });
    cookie = res.headers.get("set-cookie").split(";")[0];
  });
  after(() => new Promise((r) => server.close(r)));

  beforeEach(() => {
    calls = [];
    reply = () => ({ ok: true, result: { message_id: 77 } });
    ctx.TG_BOT_TOKEN = TOKEN;
    ctx.set("channel_id", "@chan");
  });

  const addPost = (status = "draft", text = "Новый пост") =>
    Number(ctx.db.prepare("insert into posts(head,input,text,status) values('h','i',?,?)").run(text, status).lastInsertRowid);

  const publish = async (id, body = {}) => {
    const res = await fetch(`${base}/api/posts/${id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  // Ошибка — всегда JSON с понятным текстом и машинным кодом, без токена бота
  const assertError = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.code, code);
    assert.equal(typeof r.body.error, "string");
    assert.ok(r.body.error.length > 0);
    assert.ok(!r.body.error.includes("SECRET-token"), r.body.error);
  };
  const sends = () => calls.filter((c) => c.method === "sendMessage");

  it("успешная публикация: 200, статус sent, одно сообщение в канал", async () => {
    const id = addPost();
    const r = await publish(id, { text: "  Готовый пост  " });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(sends().length, 1);
    assert.equal(sends()[0].body.chat_id, "@chan");
    assert.equal(sends()[0].body.text, "Готовый пост");
    const p = ctx.post(id);
    assert.equal(p.status, "sent");
    assert.equal(p.tg_message_id, 77);
    assert.equal(p.error, null);
  });

  it("без входа — 401", async () => {
    const res = await fetch(`${base}/api/posts/${addPost()}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.equal(sends().length, 0);
  });

  it("несуществующий пост — 404", async () => {
    assertError(await publish(999999), 404, "POST_NOT_FOUND");
    assert.equal(sends().length, 0);
  });

  it("уже опубликованный пост — 409, повторной отправки нет", async () => {
    const id = addPost("sent");
    assertError(await publish(id), 409, "POST_ALREADY_SENT");
    assertError(await publish(addPost("sending")), 409, "POST_SENDING");
    assertError(await publish(addPost("rejected")), 409, "POST_STATUS_CONFLICT");
    assert.equal(sends().length, 0);
    assert.equal(ctx.post(id).status, "sent");
  });

  it("пустой текст — 422, пост остаётся черновиком", async () => {
    const id = addPost("draft", "");
    assertError(await publish(id, { text: "   " }), 422, "POST_TEXT_EMPTY");
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(sends().length, 0);
  });

  it("текст длиннее 4096 символов — 422, в Telegram не уходит", async () => {
    const id = addPost();
    assertError(await publish(id, { text: "я".repeat(4097) }), 422, "POST_TEXT_TOO_LONG");
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(sends().length, 0);
  });

  it("текст не строкой — 400", async () => {
    assertError(await publish(addPost(), { text: { a: 1 } }), 400, "INVALID_REQUEST");
    assert.equal(sends().length, 0);
  });

  it("непроверенные утверждения без подтверждения — 409 needs_review, с подтверждением — 200", async () => {
    const id = addPost();
    ctx.db.prepare("update posts set needs_review=1 where id=?").run(id);
    assertError(await publish(id), 409, "needs_review");
    assert.equal(sends().length, 0);
    assert.equal((await publish(id, { confirm_unverified: true })).status, 200);
    assert.equal(ctx.post(id).status, "sent");
  });

  it("канал не подключён — 409, пост остаётся черновиком", async () => {
    ctx.set("channel_id", "");
    const id = addPost();
    assertError(await publish(id), 409, "TELEGRAM_CHANNEL_NOT_CONFIGURED");
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(sends().length, 0);
  });

  it("токен бота не задан — 503, пост остаётся черновиком", async () => {
    ctx.TG_BOT_TOKEN = "";
    const id = addPost();
    const r = await publish(id);
    assertError(r, 503, "TELEGRAM_BOT_NOT_CONFIGURED");
    assert.match(r.body.error, /TG_BOT_TOKEN/);
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(sends().length, 0);
  });

  it("Telegram «chat not found» — 502 с подсказкой, пост failed без пометки «прервано»", async () => {
    reply = () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" });
    const id = addPost();
    const r = await publish(id);
    assertError(r, 502, "TELEGRAM_CHAT_NOT_FOUND");
    assert.match(r.body.error, /chat not found/);
    assert.match(r.body.error, /настройках/);
    const p = ctx.post(id);
    assert.equal(p.status, "failed");
    assert.equal(p.interrupted, 0);
    assert.match(p.error, /chat not found/);
  });

  it("у бота нет прав в канале — 502 TELEGRAM_CHANNEL_PERMISSION_DENIED", async () => {
    for (const answer of [
      { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" },
      { ok: false, error_code: 400, description: "Bad Request: not enough rights to send text messages to the chat" },
      { ok: false, error_code: 400, description: "Bad Request: need administrator rights in the channel chat" },
    ]) {
      reply = () => answer;
      const id = addPost();
      const r = await publish(id);
      assertError(r, 502, "TELEGRAM_CHANNEL_PERMISSION_DENIED");
      assert.match(r.body.error, /администратором/);
      assert.equal(ctx.post(id).status, "failed");
    }
  });

  it("Telegram не принял токен — 503, не принял текст — 422, флуд-лимит — 503", async () => {
    const cases = [
      [{ ok: false, error_code: 401, description: "Unauthorized" }, 503, "TELEGRAM_BOT_TOKEN_INVALID"],
      [{ ok: false, error_code: 400, description: "Bad Request: can't parse entities: wrong offset" }, 422, "TELEGRAM_MESSAGE_REJECTED"],
      [{ ok: false, error_code: 429, description: "Too Many Requests: retry after 300", parameters: { retry_after: 300 } }, 503, "TELEGRAM_RATE_LIMITED"],
      [{ ok: false, error_code: 500, description: "Internal Server Error" }, 502, "TELEGRAM_API_ERROR"],
    ];
    for (const [answer, status, code] of cases) {
      reply = () => answer;
      const id = addPost();
      assertError(await publish(id), status, code);
      assert.equal(ctx.post(id).status, "failed");
    }
  });

  it("описание ошибки Telegram с токеном не раскрывает токен", async () => {
    reply = () => ({ ok: false, error_code: 400, description: `Bad Request: url https://api.telegram.org/bot${TOKEN}/x` });
    const id = addPost();
    const r = await publish(id);
    assertError(r, 502, "TELEGRAM_API_ERROR");
    assert.ok(!ctx.post(id).error.includes("SECRET-token"));
  });

  it("таймаут и обрыв сети Telegram — 504/502, пост «прерван»: повтор только с предупреждением", async () => {
    const realFetch = global.fetch;
    const tg = ctx.tg;
    // Настоящий клиент services.tg, подменён только сетевой запрос к api.telegram.org
    ctx.tg = (m, b, t) => services.tg(m, b, t);
    try {
      for (const [error, status, code] of [
        [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), 504, "TELEGRAM_TIMEOUT"],
        [new TypeError("fetch failed"), 502, "TELEGRAM_NETWORK_ERROR"],
      ]) {
        global.fetch = async (url, opts) => {
          if (String(url).startsWith("https://api.telegram.org/")) throw error;
          return realFetch(url, opts);
        };
        const id = addPost();
        const r = await publish(id);
        assertError(r, status, code);
        assert.match(r.body.error, /могло дойти/);
        const p = ctx.post(id);
        assert.equal(p.status, "failed");
        assert.equal(p.interrupted, 1);
      }
    } finally {
      global.fetch = realFetch;
      ctx.tg = tg;
    }
  });

  it("двойной клик: из двух одновременных запросов уходит одно сообщение, второй — 409", async () => {
    reply = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, result: { message_id: 5 } };
    };
    const id = addPost();
    const results = await Promise.all([publish(id), publish(id)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const conflict = results.find((r) => r.status === 409);
    assert.ok(["POST_SENDING", "POST_ALREADY_PUBLISHING"].includes(conflict.body.code), conflict.body.code);
    assert.equal(sends().length, 1);
    assert.equal(ctx.post(id).status, "sent");

    // После успешной отправки повтор невозможен
    assertError(await publish(id), 409, "POST_ALREADY_SENT");
    assert.equal(sends().length, 1);
  });

  it("повтор после отказа Telegram отправляет пост один раз", async () => {
    reply = () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" });
    const id = addPost();
    assert.equal((await publish(id)).status, 502);
    reply = () => ({ ok: true, result: { message_id: 9 } });
    assert.equal((await publish(id)).status, 200);
    assert.equal(sends().length, 2);
    assert.equal(ctx.post(id).status, "sent");
    assert.equal(ctx.post(id).error, null);
  });

  it("сбой базы после отправки не оставляет пост в sending: 500 и пометка «не отправляйте снова»", async () => {
    const prepare = ctx.db.prepare;
    ctx.db.prepare = function (sql) {
      if (sql.includes("status='sent'")) return { run: () => { throw new Error("SQLITE_BUSY: database is locked"); } };
      return prepare.call(this, sql);
    };
    let r;
    const id = addPost();
    try {
      r = await publish(id);
    } finally {
      ctx.db.prepare = prepare;
    }
    assertError(r, 500, "POST_STATUS_NOT_SAVED");
    assert.match(r.body.error, /Не отправляйте пост снова/);
    const p = ctx.post(id);
    assert.equal(p.status, "failed");
    assert.equal(p.interrupted, 1);
    assert.equal(sends().length, 1);
  });

  it("непредвиденная ошибка сервера — 500 INTERNAL_ERROR, а не 400", async () => {
    const post = ctx.post;
    ctx.post = () => { throw new Error("сбой чтения"); };
    const { error } = console;
    console.error = () => {};
    let r;
    try {
      r = await publish(1);
    } finally {
      ctx.post = post;
      console.error = error;
    }
    assertError(r, 500, "INTERNAL_ERROR");
  });

  it("битый JSON в запросе — 400", async () => {
    const res = await fetch(`${base}/api/posts/1/publish`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_REQUEST");
  });

  it("канал в настройках: @имя и числовой ID принимаются, ссылка и имя без @ — 400", async () => {
    const save = (channel_id) =>
      fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ channel_id }) });
    for (const ok of ["@my_channel", "-1001234567890", ""]) {
      assert.equal((await save(ok)).status, 200, ok);
      assert.equal(ctx.get("channel_id"), ok);
    }
    for (const bad of ["https://t.me/my_channel", "t.me/my_channel", "my_channel", "@a b"]) {
      assert.equal((await save(bad)).status, 400, bad);
    }
  });
});
