const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { ai } = require("../lib/services");
const { listModels, clearModelsCache, CACHE_TTL_MS, TIMEOUT_MS } = require("../lib/ai-models");
const { TEST_PASSWORD, tenantDb } = require("./helpers/tenant");

const KEY = "sk-ant-api03-SECRETmodelskey1234567890";
const OPENAI_KEY = "sk-proj-SECRETopenaikey0987654321";
const PASS = "ai-models-test-password";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Ответы в формате документации: Anthropic GET /v1/models, OpenAI GET /v1/models
const anthropicPage1 = {
  data: [
    { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T00:00:00Z", lifecycle: "active" },
    { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-08-01T00:00:00Z", lifecycle: "active" },
  ],
  has_more: true,
  first_id: "claude-opus-5-5",
  last_id: "claude-haiku-5-5",
};
const anthropicPage2 = {
  data: [
    { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-01T00:00:00Z", lifecycle: "active" },
    { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", lifecycle: "deprecated" },
  ],
  has_more: false,
  first_id: "claude-sonnet-5-5",
  last_id: "claude-haiku-4-5",
};
const openaiList = {
  object: "list",
  data: [
    "gpt-5.1", "gpt-5.1-mini", "gpt-5.1-nano", "o4-mini", "gpt-4.1", "chatgpt-4o-latest",
    "text-embedding-3-large", "text-embedding-ada-002", "tts-1-hd", "gpt-4o-mini-tts", "whisper-1",
    "gpt-4o-transcribe", "dall-e-3", "gpt-image-1", "sora-2", "gpt-4o-audio-preview", "gpt-realtime",
    "omni-moderation-latest", "gpt-3.5-turbo-instruct", "babbage-002", "davinci-002",
  ].map((id, i) => ({ id, object: "model", created: 1700000000 + i * 1000, owned_by: "openai" })),
};

describe("Подсказки моделей ИИ", () => {
  let calls;
  let handler;
  let originalFetch;

  before(() => {
    originalFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      if (String(url).startsWith("http://127.0.0.1")) return originalFetch(url, opts);
      calls.push({ url: String(url), opts });
      return handler(String(url), opts);
    };
  });
  after(() => {
    global.fetch = originalFetch;
  });
  beforeEach(() => {
    calls = [];
    clearModelsCache();
    handler = async () => json({}, 404);
  });

  it("Anthropic: все страницы через after_id, заголовки x-api-key и anthropic-version, новые первыми", async () => {
    handler = async (url) => (url.includes("after_id=") ? json(anthropicPage2) : json(anthropicPage1));
    const { models, cached } = await listModels("anthropic", KEY);
    assert.equal(cached, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
    assert.equal(calls[1].url, "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-haiku-5-5");
    assert.equal(calls[0].opts.headers["x-api-key"], KEY);
    assert.equal(calls[0].opts.headers["anthropic-version"], "2023-06-01");
    assert.ok(calls[0].opts.signal, "есть таймаут");
    assert.deepEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5"]);
    assert.equal(models[0].name, "Claude Opus 5.5");
    assert.deepEqual(models.filter((m) => m.cheaper).map((m) => m.id), ["claude-haiku-5-5", "claude-haiku-4-5"]);
    assert.deepEqual(models.filter((m) => m.deprecated).map((m) => m.id), ["claude-haiku-4-5"]);
  });

  it("OpenAI: Bearer, отфильтрованы модели не для текстового чата, новые первыми", async () => {
    handler = async () => json(openaiList);
    const { models } = await listModels("openai", OPENAI_KEY);
    assert.equal(calls[0].url, "https://api.openai.com/v1/models");
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${OPENAI_KEY}`);
    assert.deepEqual(models.map((m) => m.id), ["chatgpt-4o-latest", "gpt-4.1", "o4-mini", "gpt-5.1-nano", "gpt-5.1-mini", "gpt-5.1"]);
    assert.deepEqual(models.filter((m) => m.cheaper).map((m) => m.id), ["o4-mini", "gpt-5.1-nano", "gpt-5.1-mini"]);
  });

  it("кэш 10 минут отдельно для провайдера и ключа; «Обновить список» сбрасывает", async () => {
    handler = async () => json({ data: anthropicPage2.data, has_more: false });
    await listModels("anthropic", KEY);
    const second = await listModels("anthropic", KEY);
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1);

    await listModels("anthropic", KEY + "-другой");
    assert.equal(calls.length, 2, "другой ключ — свой кэш");

    const refreshed = await listModels("anthropic", KEY, { refresh: true });
    assert.equal(refreshed.cached, false);
    assert.equal(calls.length, 3);

    const realNow = Date.now;
    Date.now = () => realNow() + CACHE_TTL_MS + 1000;
    try {
      assert.equal((await listModels("anthropic", KEY)).cached, false, "через 10 минут — заново");
    } finally {
      Date.now = realNow;
    }
    assert.equal(TIMEOUT_MS, 10000);
  });

  for (const [name, respond, expected] of [
    ["неверный ключ (401)", async () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401), /не принял ключ \(401\)\. Проверьте ключ/],
    ["нет доступа (403)", async () => json({ error: { message: "forbidden" } }, 403), /нет доступа к списку моделей \(403\)/],
    ["лимит (429)", async () => json({ error: { message: "rate limited" } }, 429), /исчерпан лимит \(429\)\. Подождите минуту/],
    ["провайдер недоступен (529)", async () => json({ error: { message: "overloaded" } }, 529), /временно недоступен \(код 529\)/],
    ["нет сети", async () => { throw new TypeError("fetch failed"); }, /Нет связи с Anthropic: проверьте интернет/],
    ["таймаут", async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }, /не ответил за 10 секунд/],
    ["неожиданный ответ", async () => new Response("<html>", { status: 200 }), /неожиданный ответ/],
  ]) {
    it(`ошибка: ${name}`, async () => {
      handler = respond;
      await assert.rejects(() => listModels("anthropic", KEY), (err) => {
        assert.match(err.message, expected);
        assert.equal(err.message.includes(KEY), false);
        return true;
      });
    });
  }

  describe("маршруты /api/ai/models и /api/test/ai", () => {
    let server;
    let base;
    let cookie;
    let ctx;
    let logged;
    const consoleFns = ["log", "warn", "error", "info"];
    const saved = {};

    before(async () => {
      const warn = console.warn;
      console.warn = () => {};
      ctx = { ...tenantDb(":memory:", "ai-models-key"), ADMIN_PASSWORD: PASS, SESSION_SECRET: "s".repeat(40), ai: (i, f, o) => ai(i, f, o) };
      console.warn = warn;
      server = http.createServer(createApp(ctx));
      await new Promise((r) => server.listen(0, r));
      base = `http://127.0.0.1:${server.address().port}`;
      const l = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }) });
      cookie = l.headers.get("set-cookie").split(";")[0];
    });
    after(() => new Promise((r) => server.close(r)));
    beforeEach(() => {
      logged = [];
      for (const fn of consoleFns) {
        saved[fn] = console[fn];
        console[fn] = (...args) => logged.push(args.join(" "));
      }
      ctx.set("ai_key", "");
      ctx.set("ai_provider", "anthropic");
    });
    const restoreConsole = () => {
      for (const fn of consoleFns) console[fn] = saved[fn];
    };

    const req = (method, path, body) =>
      fetch(base + path, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

    it("без сессии — 401", async () => {
      restoreConsole();
      assert.equal((await fetch(`${base}/api/ai/models`)).status, 401);
    });

    it("GET берёт сохранённый ключ; ответ без ключа", async () => {
      ctx.set("ai_key", KEY);
      handler = async () => json(anthropicPage2);
      const res = await req("GET", "/api/ai/models");
      const text = await res.text();
      restoreConsole();
      assert.equal(res.status, 200);
      assert.equal(calls[0].opts.headers["x-api-key"], KEY);
      assert.equal(text.includes(KEY), false);
      assert.deepEqual(JSON.parse(text).models.map((m) => m.id), ["claude-sonnet-5-5", "claude-haiku-4-5"]);
      assert.equal(logged.join("\n").includes(KEY), false);
    });

    it("POST с несохранённым ключом: ключ только для запроса, не сохраняется и нигде не всплывает", async () => {
      // Провайдер, который «вернул» ключ в тексте ошибки
      handler = async () => json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}. You can find your API key at platform.openai.com.` } }, 400);
      const res = await req("POST", "/api/ai/models", { provider: "openai", key: OPENAI_KEY });
      const text = await res.text();
      restoreConsole();
      assert.equal(res.status, 400);
      assert.equal(calls[0].opts.headers.Authorization, `Bearer ${OPENAI_KEY}`);
      assert.equal(text.includes(OPENAI_KEY), false, "ключ не в ответе");
      assert.equal(text.includes("SECRETopenai"), false);
      assert.match(JSON.parse(text).error, /OpenAI вернул ошибку 400: Incorrect API key provided/);
      assert.equal(ctx.get("ai_key"), "", "ключ не сохранён");
      assert.equal(logged.join("\n").includes(OPENAI_KEY), false, "ключ не в логах");
    });

    it("при ошибке провайдера — запасной список с пометкой, без ключа", async () => {
      ctx.set("ai_key", KEY);
      handler = async () => json({ error: { message: "x" } }, 401);
      const res = await req("GET", "/api/ai/models?provider=anthropic");
      restoreConsole();
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.match(body.error, /не принял ключ \(401\)/);
      assert.deepEqual(body.fallback.map((m) => m.id), ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    });

    it("без ключа — понятная ошибка, запрос к провайдеру не уходит", async () => {
      const res = await req("GET", "/api/ai/models");
      restoreConsole();
      assert.match((await res.json()).error, /Сначала введите ключ ИИ/);
      assert.equal(calls.length, 0);
    });

    it("«Проверить ИИ»: выбранная модель, время и начало ответа", async () => {
      ctx.set("ai_key", KEY);
      ctx.set("ai_model", "claude-haiku-5-5");
      handler = async (url, opts) => {
        handler.body = JSON.parse(opts.body);
        return json({ content: [{ type: "text", text: "Связь есть, всё работает отлично и быстро." }], stop_reason: "end_turn" });
      };
      const res = await req("POST", "/api/test/ai", { provider: "anthropic", model: "claude-sonnet-5-5" });
      restoreConsole();
      const body = await res.json();
      assert.equal(handler.body.model, "claude-sonnet-5-5", "выбранная, а не сохранённая модель");
      assert.match(body.message, /^Ответ за \d+\.\d с \(anthropic, claude-sonnet-5-5\): «Связь есть, всё работает/);
      assert.equal(ctx.get("ai_model"), "claude-haiku-5-5", "модель не сохраняется проверкой");
    });

    it("«Проверить ИИ»: точная причина ошибки без ключа", async () => {
      handler = async () => json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, 401);
      const res = await req("POST", "/api/test/ai", { provider: "openai", model: "gpt-5.1", key: OPENAI_KEY });
      restoreConsole();
      const text = await res.text();
      assert.equal(res.status, 400);
      assert.match(JSON.parse(text).error, /^OpenAI: Incorrect API key provided/);
      assert.equal(text.includes(OPENAI_KEY), false);
      assert.equal(ctx.get("ai_key"), "");
    });
  });
});
