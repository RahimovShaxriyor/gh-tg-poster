const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/db");
const poster = require("../lib/poster");
const pipeline = require("../lib/pipeline");
const { fakeAi } = require("./helpers/fake-ai");

const SHA = "a".repeat(40);
const DATA = { commits: [{ sha: SHA, message: "feat: экспорт в Markdown" }], files: [{ filename: "src/export.js", additions: 1, deletions: 0, patch: "+export" }] };
const FACT = { id: "f1", claim: "Заметку можно выгрузить в Markdown из меню заметки", feature: "Экспорт", evidence: [{ sha: "aaaaaaa", file: null }], user_visible: true, confidence: "high" };
const GOOD = "Заметки теперь уезжают в Markdown\n\nОткройте меню заметки и выберите «Экспорт».\n\nФайл сохранится в формате Markdown.";
const variantsAnswer = (texts) => JSON.stringify({ variants: texts.map((text, i) => ({ angle: `a${i + 1}`, text, used_facts: ["f1"], sentences: [], skipped: [] })) });
const run = (opts) => pipeline.runPipeline({ data: DATA, profile: { audience: "users", emoji: "few" }, ...opts });

describe("Написание по заходу: структура и варианты", () => {
  it("в промпте — структура: заголовок до 90 символов, 2–4 абзаца, факт-деталь, призыв, лимит эмодзи", () => {
    const sys = pipeline.WRITE_SYSTEM({ count: 3 });
    assert.match(sys, /Первая строка — заголовок-крючок до 90 символов: из hook захода\. Без звёздочек/);
    assert.match(sys, /Затем 2–4 коротких абзаца/);
    assert.match(sys, /Один конкретный факт-деталь из <facts>/);
    assert.match(sys, /Последняя строка — как сказано в «Призыв в конце»/);
    assert.match(sys, /Эмодзи — не больше, чем разрешено/);
    assert.match(sys, /Заход может быть свободным, утверждения — только из фактов/);
    assert.match(sys, /«Раньше было иначе», «больше не нужно», «вместо …» — только если это прямо сказано в фактах/);
  });

  it("три варианта одним вызовом: выбранный проверен ИИ, остальные — кодом и помечены «не проверен»", async () => {
    const calls = [];
    const r = await run({
      call: fakeAi({ facts: [FACT], calls, raw: { write: variantsAnswer([GOOD, GOOD.replace("Заметки теперь", "А вы знали? Заметки"), "Как вы переносите заметки?\n\nВ меню заметки есть «Экспорт» в 7 форматов."]) } }),
    });
    assert.deepEqual(calls.map((c) => c.step), ["facts", "angles", "write", "verify"]);
    assert.equal(r.status, "draft");
    assert.equal(r.text, GOOD);
    assert.deepEqual(r.meta.variants.map((v) => [v.angle, v.check.status]), [["a1", "ok"], ["a2", "unverified"], ["a3", "needs_review"]]);
    assert.deepEqual(r.meta.variants[2].check.issues.map((i) => i.quote), ["7"], "выдуманное число в невыбранном варианте поймано кодом");
    assert.equal(r.meta.selected, 0);
    assert.equal(r.meta.headline, true);
  });

  it("звёздочки и решётки вокруг заголовка убираются: жирным его делает бот", () => {
    const parsed = pipeline.parseWrite(JSON.stringify({ text: "**Экспорт в Markdown**\n\nТекст" }), [FACT], ["a1"]);
    assert.equal(parsed.variants[0].text, "Экспорт в Markdown\n\nТекст");
    assert.equal(pipeline.parseWrite(JSON.stringify({ text: "## Заголовок\nТекст" }), [FACT]).variants[0].text, "Заголовок\nТекст");
  });

  it("проверка подачи: заголовок длиннее 90, лишние эмодзи, запретные слова, призыв", () => {
    const long = "З".repeat(91);
    const issues = (text, profile) => pipeline.styleCheck(text, profile).map((i) => i.kind);
    assert.deepEqual(issues(`${long}\n\nТекст`, {}), ["headline"]);
    assert.deepEqual(issues("Заголовок 🎉\n\nТекст 🚀 и ещё ✨", { emoji: "few" }), ["emoji"]);
    assert.deepEqual(issues("Заголовок 🎉\n\nТекст", { emoji: "none" }), ["emoji"]);
    assert.deepEqual(issues("Встречайте революционный экспорт\n\nТекст", { banned: "революционный, встречайте" }), ["banned", "banned"]);
    assert.deepEqual(issues("Заголовок\n\nТекст.", { cta: "question" }), ["cta"]);
    assert.deepEqual(issues("Заголовок\n\nА вы чем пользуетесь? 🙂", { cta: "question" }), []);
    assert.deepEqual(issues("Заголовок\n\nПодробнее: https://github.com/me/notes", { cta: "link", link: "https://github.com/me/notes" }), []);
    assert.deepEqual(issues("Заголовок\n\nНа этом всё.", { cta: "link", link: "https://github.com/me/notes" }), ["cta"]);
  });

  it("нарушение подачи — одна перегенерация выбранного варианта с замечанием, даже без строгой проверки", async () => {
    const calls = [];
    const long = "Очень длинный заголовок, который никак не помещается в девяносто символов и тянется всё дальше и дальше";
    assert.ok(long.length > 90);
    const r = await run({
      strict: false, variants: 1,
      call: fakeAi({ facts: [FACT], calls, text: (req, n) => (n === 1 ? `${long}\n\nТекст` : GOOD) }),
    });
    assert.deepEqual(calls.map((c) => c.step), ["facts", "angles", "write", "write"]);
    assert.match(calls[3].user, /заголовок длиннее 90 символов/);
    assert.equal(r.text, GOOD);
    assert.deepEqual(r.meta.check.style, []);
    assert.equal(r.meta.check.regenerated, true);
  });

  it("«раньше было» без опоры ловится; если это есть в фактах — проходит", () => {
    const issues = pipeline.pastCheck("Экспорт готов. Раньше приходилось копировать вручную!", "Заметку можно выгрузить в Markdown");
    assert.deepEqual(issues.map((i) => i.quote), ["Раньше приходилось копировать вручную!"]);
    assert.deepEqual(pipeline.pastCheck("Больше не нужно копировать вручную.", "Раньше экспорта не было, заметки копировали вручную"), []);
    assert.deepEqual(pipeline.pastCheck("Теперь можно выгрузить заметку.", "x"), [], "«теперь можно» — не сравнение");
  });
});

describe("Публикация: заголовок жирным", () => {
  it("пост от конвейера уходит с entity bold на первую строку; старый пост — без разметки", async () => {
    const w = console.warn;
    console.warn = () => {};
    const sent = [];
    const ctx = { ...createDatabase(":memory:", "writing-key"), TG_BOT_TOKEN: "1:a", tg: async (m, body) => (sent.push(body), { ok: true, result: { message_id: 1 } }) };
    console.warn = w;
    ctx.set("channel_id", "@chan");
    const withHead = Number(ctx.db.prepare("insert into posts(head,input,text,status,meta) values('h','i',?, 'draft', ?)").run("Экспорт в Markdown 📝\nТекст", JSON.stringify({ headline: true })).lastInsertRowid);
    const old = Number(ctx.db.prepare("insert into posts(head,input,text,status) values('h','i','Старый пост','draft')").run().lastInsertRowid);
    await poster.publish(withHead, null, ctx);
    await poster.publish(old, null, ctx);
    // Длина — в единицах UTF-16, как считает Telegram (эмодзи — 2)
    assert.deepEqual(sent[0].entities, [{ type: "bold", offset: 0, length: "Экспорт в Markdown 📝".length }]);
    assert.equal(sent[0].entities[0].length, 21);
    assert.equal(sent[1].entities, undefined);
  });

  it("настройка вариантов: «1» — один текст, по умолчанию — три", async () => {
    const w = console.warn;
    console.warn = () => {};
    const calls = [];
    const ctx = { ...createDatabase(":memory:", "writing-key2"), aiCall: fakeAi({ facts: [FACT], calls }) };
    console.warn = w;
    ctx.set("ai_key", "k");
    ctx.set("ai_model", "m");
    const add = () => Number(ctx.db.prepare("insert into posts(head,input,input_data,status) values('h','i',?,'draft')").run(JSON.stringify(DATA)).lastInsertRowid);
    await poster.generate(add(), true, ctx);
    assert.match(calls.find((c) => c.step === "write").system, /Напиши 3 варианта/);
    calls.length = 0;
    ctx.set("variants", "1");
    await poster.generate(add(), true, ctx);
    assert.equal(/Напиши 3 варианта/.test(calls.find((c) => c.step === "write").system), false);
  });
});
