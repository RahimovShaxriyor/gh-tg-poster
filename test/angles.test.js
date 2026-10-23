const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pipeline = require("../lib/pipeline");
const { fakeAi } = require("./helpers/fake-ai");

const SHA = "a".repeat(40);
const DATA = { commits: [{ sha: SHA, message: "feat: экспорт" }], files: [{ filename: "src/export.js", additions: 1, deletions: 0, patch: "+export" }] };
const FACT = { id: "f1", claim: "Заметку можно выгрузить в Markdown", feature: "Экспорт", evidence: [{ sha: "aaaaaaa", file: null }], user_visible: true, confidence: "high" };
const run = (opts) => pipeline.runPipeline({ data: DATA, profile: { audience: "users" }, ...opts });

describe("Шаг «Заход»", () => {
  it("идёт между фактами и текстом: получает факты, профиль и журнал как данные", async () => {
    const calls = [];
    await run({ announced: [{ name: "Тёмная тема", summary: "уже было" }], call: fakeAi({ facts: [FACT], calls }) });
    assert.deepEqual(calls.map((c) => c.step).slice(0, 3), ["facts", "angles", "write"]);
    const a = calls[1];
    assert.match(a.user, /^<facts>\n[\s\S]*Заметку можно выгрузить в Markdown[\s\S]*<\/facts>\n\n<channel_profile>\nКто читает: Клиенты или пользователи продукта/);
    assert.match(a.user, /<announced>\n- Тёмная тема: уже было\n<\/announced>/);
    assert.match(a.system, /"benefit" — польза[\s\S]*"story" — история или закулисье[\s\S]*"question" — вопрос к аудитории/);
    assert.match(a.system, /hook — цепляющая первая строка до 90 символов/);
    assert.match(a.system, /Никаких чисел, сроков, обещаний и сравнений «было — стало», которых нет в фактах/);
  });

  it("три захода в одном ответе; при «один вариант» первый заход уходит в написание блоком <angle>", async () => {
    const calls = [];
    const r = await run({ variants: 1, call: fakeAi({ facts: [FACT], calls }) });
    assert.deepEqual(r.meta.angles.list.map((x) => [x.id, x.type]), [["a1", "benefit"], ["a2", "story"], ["a3", "question"]]);
    assert.equal(r.meta.angles.focus, "Главное для читателя");
    assert.equal(r.meta.angle, "a1");
    const write = calls.find((c) => c.step === "write");
    assert.match(write.user, /<angle>\n\{\n "id": "a1",\n "name": "Польза",\n "hook": "Теперь это можно сделать быстрее",/);
    assert.match(write.system, /Заход — подача, а не источник фактов: утверждения только из <facts>/);
  });

  it("при «три варианта» в написание уходят все заходы блоком <angles>, ответ — три варианта", async () => {
    const calls = [];
    await run({ variants: 3, call: fakeAi({ facts: [FACT], calls }) });
    const write = calls.find((c) => c.step === "write");
    assert.match(write.user, /<angles>\n\[\n \{\n {2}"id": "a1",[\s\S]*"id": "a3"[\s\S]*<\/angles>/);
    assert.equal(write.user.includes("<angle>"), false);
    assert.match(write.system, /Напиши 3 варианта — по одному на каждый заход из <angles>/);
  });

  it("разбор: первая строка не длиннее 90 символов, повтор типа заменяется свободным, мусор пропускается", () => {
    const long = "Очень длинная первая строка, которая продолжается и продолжается дальше, пока не станет длиннее девяноста символов";
    const parsed = pipeline.parseAngles(JSON.stringify({
      focus: "фокус",
      angles: [
        { type: "benefit", name: "Польза", hook: long, idea: "мысль" },
        { type: "benefit", name: "Ещё польза", hook: "Вторая", idea: "мысль" },
        null,
        { type: "question", name: "Вопрос", hook: "" },
        { type: "question", name: "Вопрос", hook: "Как вы это делаете?" },
      ],
    }));
    assert.deepEqual(parsed.list.map((x) => x.type), ["benefit", "story", "question"]);
    assert.ok(parsed.list[0].hook.length <= 90, parsed.list[0].hook);
    assert.match(parsed.list[0].hook, /…$/);
    assert.equal(pipeline.parseAngles("просто текст"), null);
  });

  it("заходы не в JSON — пост всё равно пишется, без захода и с пометкой", async () => {
    const calls = [];
    const r = await run({ call: fakeAi({ facts: [FACT], angles: "Вот мои идеи: …", calls }) });
    assert.equal(r.status, "draft");
    assert.equal(r.meta.angle, null);
    assert.match(r.meta.angles.error, /не в формате JSON/);
    assert.equal(calls.find((c) => c.step === "write").user.includes("<angle>"), false);
  });

  it("ошибка провайдера на шаге захода — failed с названием шага", async () => {
    const r = await run({ call: fakeAi({ facts: [FACT], raw: { angles: () => { throw new Error("overloaded"); } } }) });
    assert.equal(r.status, "failed");
    assert.equal(r.error, "Заход: overloaded");
  });

  it("нет подходящих фактов — заход не запрашивается (токены не тратятся)", async () => {
    const calls = [];
    const r = await run({ call: fakeAi({ facts: [{ ...FACT, user_visible: false }], calls }) });
    assert.equal(r.status, "skipped");
    assert.deepEqual(calls.map((c) => c.step), ["facts"]);
  });
});
