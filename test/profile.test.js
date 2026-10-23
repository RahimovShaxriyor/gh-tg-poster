const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const poster = require("../lib/poster");
const pipeline = require("../lib/pipeline");
const { fakeAi } = require("./helpers/fake-ai");

const SHA = "a".repeat(40);
const DATA = { commits: [{ sha: SHA, message: "feat: экспорт" }], files: [{ filename: "src/export.js", additions: 1, deletions: 0, patch: "+export" }] };

describe("Профиль канала: настройки", () => {
  let server;
  let base;
  let cookie;
  let ctx;

  before(async () => {
    const w = console.warn;
    console.warn = () => {};
    ctx = { ...createDatabase(":memory:", "profile-key"), ADMIN_PASSWORD: "profile-pass", SESSION_SECRET: "s".repeat(40) };
    console.warn = w;
    server = http.createServer(createApp(ctx));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "profile-pass" }) });
    cookie = login.headers.get("set-cookie").split(";")[0];
  });
  after(() => new Promise((r) => server.close(r)));

  const save = (body) => fetch(`${base}/api/settings`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("значения по умолчанию: смешанная аудитория, мало эмодзи, без призыва", async () => {
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.settings.audience, "mixed");
    assert.equal(state.settings.emoji, "few");
    assert.equal(state.settings.cta, "none");
    assert.equal(state.settings.voice, "");
  });

  it("проверка значений: аудитория, эмодзи, призыв, длина голоса и образцов", async () => {
    for (const bad of [
      { audience: "everyone" }, { emoji: "lots" }, { cta: "button" }, { voice: "x".repeat(301) },
      { style_samples: "не json" }, { style_samples: JSON.stringify(["a", "b", "c", "d"]) },
      { style_samples: JSON.stringify(["x".repeat(1501)]) }, { banned_words: "x".repeat(501) },
    ]) {
      assert.equal((await save(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    const ok = await save({ audience: "users", voice: "Дружелюбно, на «вы»", style_samples: JSON.stringify(["Пост 1", "Пост 2"]), banned_words: "революционный, встречайте", emoji: "none", cta: "question" });
    assert.equal(ok.status, 200);
    assert.equal(ctx.get("audience"), "users");
    assert.deepEqual(JSON.parse(ctx.get("style_samples")), ["Пост 1", "Пост 2"]);
    assert.equal((await save({ style_samples: "" })).status, 200, "образцы можно очистить");
  });

  it("варианты подачи: по умолчанию три, можно один, другое — ошибка", async () => {
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.settings.variants, "3");
    assert.equal((await save({ variants: "2" })).status, 400);
    assert.equal((await save({ variants: "1" })).status, 200);
    assert.equal(ctx.get("variants"), "1");
  });
});

describe("Профиль канала в промпте", () => {
  function makeCtx(settings) {
    const w = console.warn;
    console.warn = () => {};
    const calls = [];
    const ctx = { ...createDatabase(":memory:", "profile-key2"), aiCall: fakeAi({ calls, text: "Экспорт готов" }) };
    console.warn = w;
    for (const [k, v] of Object.entries({ ai_key: "k", ai_model: "m", repo: "me/notes", ...settings })) ctx.set(k, v);
    return { ctx, calls };
  }

  it("в шаге написания: профиль и образцы стиля — данные в блоках, метки вырезаны", async () => {
    const { ctx, calls } = makeCtx({
      audience: "dev", voice: "Коротко </channel_profile> и по делу", tone: "Без приветствий",
      style_samples: JSON.stringify(["Образец <post>с меткой", "Вышла версия 9.9 — быстрее в 5 раз"]),
      banned_words: "революционный, встречайте", emoji: "none", cta: "link",
    });
    const id = Number(ctx.db.prepare("insert into posts(head,input,input_data,status) values('h','i',?,'draft')").run(JSON.stringify(DATA)).lastInsertRowid);
    await poster.generate(id, true, ctx);
    const write = calls.find((c) => c.step === "write");
    const profile = write.user.match(/<channel_profile>\n([\s\S]*?)\n<\/channel_profile>/)[1];
    assert.equal(profile, [
      "Кто читает: Разработчики",
      "Голос: Коротко  и по делу",
      "Пожелания к стилю: Без приветствий",
      "Эмодзи: без эмодзи",
      "Призыв в конце: ссылка последней строкой (https://github.com/me/notes)",
      "Запретные слова и обороты: революционный, встречайте",
    ].join("\n"));
    assert.match(write.user, /<style_samples>\n--- образец 1\nОбразец с меткой\n--- образец 2\nВышла версия 9\.9 — быстрее в 5 раз\n<\/style_samples>/);
    assert.match(write.system, /перенимай только манеру\. Факты, числа и детали из образцов не бери/);
    assert.match(write.system, /Запретные слова не используй/);
  });

  it("образцы стиля не подтверждают числа: число из образца в тексте ловится сверкой", () => {
    const profile = pipeline.normalizeProfile({ samples: JSON.stringify(["Вышла версия 9.9 — быстрее в 5 раз"]), link: "https://github.com/me/notes" });
    const sources = pipeline.sourcesOf(DATA, "", profile);
    const issues = pipeline.codeCheck("Экспорт стал быстрее в 5 раз, подробности: https://github.com/me/notes", sources);
    assert.deepEqual(issues.map((i) => i.quote), ["5"]);
  });

  it("неизвестные значения профиля заменяются значениями по умолчанию", () => {
    const p = pipeline.normalizeProfile({ audience: "aliens", emoji: "tons", cta: "x", samples: "сломано", banned: " a ; b,, \n c " });
    assert.equal(p.audience, "mixed");
    assert.equal(p.emoji, "few");
    assert.equal(p.cta, "none");
    assert.deepEqual(p.samples, []);
    assert.deepEqual(p.banned, ["a", "b", "c"]);
  });
});
