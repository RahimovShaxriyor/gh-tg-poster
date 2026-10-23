const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const poster = require("../lib/poster");
const { fakeAi } = require("./helpers/fake-ai");

const SHA = "a".repeat(40);
const DATA = { commits: [{ sha: SHA, message: "feat: экспорт в Markdown" }], files: [{ filename: "src/export.js", additions: 1, deletions: 0, patch: "+export" }] };
const FACT = { id: "f1", claim: "Заметку можно выгрузить в Markdown из меню заметки", feature: "Экспорт", evidence: [{ sha: "aaaaaaa", file: null }], user_visible: true, confidence: "high" };
const TEXTS = [
  "Заметки уезжают в Markdown\n\nВ меню заметки есть «Экспорт».",
  "Как мы сделали экспорт\n\nВ меню заметки появился «Экспорт».",
  "Как вы переносите заметки?\n\nТеперь в меню заметки есть «Экспорт».",
];
const variantsAnswer = JSON.stringify({ variants: TEXTS.map((text, i) => ({ angle: `a${i + 1}`, text, used_facts: ["f1"], sentences: [], skipped: [] })) });

function setup(options = {}, settings = {}) {
  const w = console.warn;
  console.warn = () => {};
  const calls = [];
  const ctx = { ...createDatabase(":memory:", "variants-key"), ADMIN_PASSWORD: "variants-pass", SESSION_SECRET: "s".repeat(40) };
  console.warn = w;
  ctx.aiCall = fakeAi({ facts: [FACT], calls, raw: { write: (req, n) => (n === 1 && !settings.variants ? variantsAnswer : JSON.stringify({ text: options.rewrite || "Новая версия\n\nВ меню заметки есть «Экспорт».", used_facts: ["f1"] })) }, ...options });
  for (const [k, v] of Object.entries({ ai_key: "k", ai_model: "m", ...settings })) ctx.set(k, v);
  const id = Number(ctx.db.prepare("insert into posts(head,input,input_data,status) values('h','i',?,'draft')").run(JSON.stringify(DATA)).lastInsertRowid);
  return { ctx, calls, id };
}

describe("Варианты подачи: выбор и быстрые кнопки", () => {
  it("выбор готового проверенного варианта — без вызова ИИ; выбор запоминается", async () => {
    const { ctx, calls, id } = setup();
    await poster.generate(id, true, ctx);
    // Проверяем все варианты, чтобы выбор не требовал проверки
    for (const a of ["a2", "a3"]) await poster.variant(id, ctx, { action: "select", angle: a });
    calls.length = 0;
    const r = await poster.variant(id, ctx, { action: "select", angle: "a2" });
    assert.equal(r.status, "draft");
    assert.equal(calls.length, 0, "без нового вызова ИИ");
    const p = ctx.post(id);
    assert.equal(p.text, TEXTS[1]);
    const meta = JSON.parse(p.meta);
    assert.equal(meta.selected, 1);
    assert.equal(meta.angle, "a2");
    assert.deepEqual(meta.tried, ["a1", "a2", "a3"]);
  });

  it("выбор непроверенного варианта — проверка ИИ одним вызовом перед тем, как он станет текстом поста", async () => {
    const { ctx, calls, id } = setup();
    await poster.generate(id, true, ctx);
    assert.equal(JSON.parse(ctx.post(id).meta).variants[1].check.status, "unverified");
    calls.length = 0;
    await poster.variant(id, ctx, { action: "select", angle: "a2" });
    assert.deepEqual(calls.map((c) => c.step), ["verify"]);
    assert.match(calls[0].user, /<post>\nКак мы сделали экспорт/);
    const meta = JSON.parse(ctx.post(id).meta);
    assert.equal(meta.variants[1].check.status, "ok");
    assert.equal(ctx.post(id).needs_review, 0);
  });

  it("при «один вариант» другой заход пишется по требованию: написание + проверка", async () => {
    const { ctx, calls, id } = setup({}, { variants: "1" });
    await poster.generate(id, true, ctx);
    assert.equal(JSON.parse(ctx.post(id).meta).variants.length, 1);
    calls.length = 0;
    await poster.variant(id, ctx, { action: "select", angle: "a3" });
    assert.deepEqual(calls.map((c) => c.step), ["write", "verify"]);
    assert.match(calls[0].user, /<angle>\n\{\n "id": "a3",/);
    const meta = JSON.parse(ctx.post(id).meta);
    assert.deepEqual(meta.variants.map((v) => v.angle), ["a1", "a3"]);
    assert.equal(meta.angle, "a3");
  });

  it("«Ярче», «Проще», «Короче», «Больше пользы»: подсказка и прошлый текст уходят в перегенерацию, результат проверяется", async () => {
    for (const [hint, phrase] of [["brighter", "Ярче"], ["simpler", "Проще"], ["shorter", "Короче"], ["benefit", "Больше пользы"]]) {
      const { ctx, calls, id } = setup();
      await poster.generate(id, true, ctx);
      calls.length = 0;
      await poster.variant(id, ctx, { action: "rewrite", hint });
      assert.deepEqual(calls.map((c) => c.step), ["write", "verify"], hint);
      assert.match(calls[0].user, new RegExp(`Пожелание автора к новой версии: ${phrase}:`));
      assert.match(calls[0].user, /<previous_text>\nЗаметки уезжают в Markdown/);
      assert.match(calls[0].user, /утверждения — только из <facts>/);
      assert.equal(ctx.post(id).text, "Новая версия\n\nВ меню заметки есть «Экспорт».");
      assert.equal(JSON.parse(ctx.post(id).meta).variants[0].hint, hint);
    }
  });

  it("быстрая кнопка не может протащить выдуманное: число в новой версии ловится проверкой", async () => {
    const { ctx, id } = setup({ rewrite: "Экспорт в 5 форматов!\n\nВ меню заметки есть «Экспорт»." });
    await poster.generate(id, true, ctx);
    await poster.variant(id, ctx, { action: "rewrite", hint: "brighter" });
    const meta = JSON.parse(ctx.post(id).meta);
    assert.equal(ctx.post(id).needs_review, 1);
    assert.ok(meta.check.issues.some((i) => i.quote === "5"));
  });

  it("ошибка ИИ не трогает текст: пост остаётся черновиком", async () => {
    const { ctx, id } = setup({ raw: { verify: (req, n) => (n === 1 ? '{"unsupported":[]}' : (() => { throw new Error("overloaded"); })()) } });
    await poster.generate(id, true, ctx);
    const before = ctx.post(id).text;
    await assert.rejects(() => poster.variant(id, ctx, { action: "select", angle: "a2" }), /Проверка: overloaded/);
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(ctx.post(id).text, before);
  });

  it("менять варианты можно только у черновика", async () => {
    const { ctx, id } = setup();
    await poster.generate(id, true, ctx);
    ctx.db.prepare("update posts set status='sent' where id=?").run(id);
    await assert.rejects(() => poster.variant(id, ctx, { action: "select", angle: "a2" }), /только у черновика/);
  });

  describe("API", () => {
    let server;
    let base;
    let cookie;
    let env;
    before(async () => {
      env = setup();
      await poster.generate(env.id, true, env.ctx);
      server = http.createServer(createApp(env.ctx));
      await new Promise((r) => server.listen(0, r));
      base = `http://127.0.0.1:${server.address().port}`;
      const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "variants-pass" }) });
      cookie = login.headers.get("set-cookie").split(";")[0];
    });
    after(() => new Promise((r) => server.close(r)));
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

    it("проверка входа и успешный выбор", async () => {
      assert.equal((await post(`/api/posts/${env.id}/variant`, { angle: "a9" })).status, 400);
      assert.equal((await post(`/api/posts/${env.id}/rewrite`, { hint: "louder" })).status, 400);
      const ok = await post(`/api/posts/${env.id}/variant`, { angle: "a3" });
      assert.equal(ok.status, 200);
      assert.equal(env.ctx.post(env.id).text, TEXTS[2]);
    });
  });
});
