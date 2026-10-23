const { describe, it, before, after, afterEach } = require("node:test");
const { postAi } = require("./helpers/fake-ai");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { ai, TIMEOUTS } = require("../lib/services");

describe("Перегенерация, таймауты, зависшие посты", () => {
  const TEST_PASS = "poster-test-pass";
  let server;
  let baseUrl;
  let ctx;
  let originalFetch;
  let mockFetchHandler;
  let sentMessages;

  before(async () => {
    originalFetch = global.fetch;
    global.fetch = async (...args) => {
      const url = String(args[0] || "");
      if (url.includes("127.0.0.1")) return originalFetch(...args);
      if (!mockFetchHandler) throw new Error("Неожиданный внешний запрос в тесте: " + url);
      return mockFetchHandler(...args);
    };

    ctx = {
      ...createDatabase(":memory:", "poster-test-key"),
      ADMIN_PASSWORD: TEST_PASS,
      SESSION_SECRET: TEST_PASS,
      tg: async (method, body) => {
        sentMessages.push({ method, body });
        return { ok: true, result: { message_id: 1 } };
      },
      aiCall: postAi(async () => "Новый вариант анонса"),
    };
    server = http.createServer(createApp(ctx));
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    mockFetchHandler = null;
  });

  async function cookie() {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASS }),
    });
    return res.headers.get("set-cookie").split(";")[0];
  }

  for (const status of ["draft", "skipped", "failed", "rejected"]) {
    it(`regen в режиме auto (из статуса ${status}) создаёт черновик и ничего не публикует`, async () => {
      sentMessages = [];
      ctx.set("mode", "auto");
      ctx.set("channel_id", "@chan");
      ctx.set("tg_token", "123:abc");
      ctx.set("ai_key", "k");
      ctx.set("ai_model", "m");
      const id = ctx.db.prepare("insert into posts(status, input, text) values(?, 'Коммиты: x', 'старый')").run(status).lastInsertRowid;

      const res = await fetch(`${baseUrl}/api/posts/${id}/regen`, { method: "POST", headers: { cookie: await cookie() } });
      assert.equal(res.status, 200);
      assert.equal(ctx.post(id).status, "draft");
      assert.equal(ctx.post(id).text, "Новый вариант анонса");
      assert.equal(sentMessages.filter((m) => m.body.chat_id === "@chan").length, 0);
    });
  }

  it("посты, зависшие в sending, при старте переводятся в failed с понятной ошибкой", () => {
    const db = createDatabase(":memory:", "k");
    const id = db.db.prepare("insert into posts(status, text) values('sending', 't')").run().lastInsertRowid;
    assert.equal(db.recoverStuckSending(), 1);
    assert.equal(db.post(id).status, "failed");
    assert.match(db.post(id).error, /прервана перезапуском/);
  });

  it("ai(): зависший запрос прерывается по таймауту с понятной ошибкой", async () => {
    const saved = TIMEOUTS.ai;
    TIMEOUTS.ai = 50;
    mockFetchHandler = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
      });
    try {
      await assert.rejects(
        ai("input", false, { provider: "anthropic", key: "k", model: "m" }),
        /не ответил за 0.05 с/
      );
    } finally {
      TIMEOUTS.ai = saved;
    }
  });
});
