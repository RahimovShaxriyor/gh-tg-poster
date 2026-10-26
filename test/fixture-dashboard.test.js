const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/db");
const poster = require("../lib/poster");
const pipeline = require("../lib/pipeline");
const { fakeAi } = require("./helpers/fake-ai");
const F = require("./fixtures/dashboard");
const { tenantDb, channelAdmin } = require("./helpers/tenant");

const PROFILE = { emoji: "few", cta: "question" };
const codeWords = pipeline.codeWordsOf(F.DATA);
const variantsOf = (text) => JSON.stringify({ variants: ["a1", "a2", "a3"].map((angle) => ({ angle, text, used_facts: ["f1", "f2"], sentences: [], skipped: [] })) });

// Прогон конвейера на фикстуре: первый ответ шага написания — first, перегенерация — second
async function run(audience, first, second = first, extra = {}) {
  const calls = [];
  const r = await pipeline.runPipeline({
    data: F.DATA, profile: { ...PROFILE, audience }, variants: 3,
    call: fakeAi({ facts: F.FACTS, angles: F.ANGLES, calls, raw: { write: (req, n) => (n === 1 ? variantsOf(first) : JSON.stringify({ text: second, used_facts: ["f1", "f2"] })) }, ...extra }),
  });
  return { r, calls };
}

describe("Фикстура: feat(pms): add durable dashboard persistence", () => {
  it("«до»: сухой пересказ кода — для пользователей это сплошь «слишком технично»", () => {
    const words = pipeline.jargonCheck(F.DRY, "users", codeWords).map((i) => i.quote);
    for (const w of ["endpoint", "bootstrap", "ADMIN", "DashboardSnapshotService", "DashboardBootstrapService", "DTO", "сущности", "репозитории", "read model"]) {
      assert.ok(words.includes(w), `не пойман «${w}»`);
    }
    assert.ok(pipeline.jargonCheck(F.DRY, "dev", codeWords).length > 0, "и для разработчиков термины без объяснений");
  });

  it("«Клиенты»: сухой текст отправляется на перегенерацию с «слишком технично», в итоговом тексте технических слов нет", async () => {
    const { r, calls } = await run("users", F.DRY, F.AFTER.users);
    const rewrite = calls.filter((c) => c.step === "write")[1];
    assert.match(rewrite.user, /слишком технично/);
    assert.match(calls.find((c) => c.step === "write").system, /Читают пользователи продукта, не программисты/);
    assert.equal(r.text, F.AFTER.users);
    assert.deepEqual(pipeline.findJargon(r.text, codeWords), [], "ни endpoint, ни DTO, ни ADMIN, ни названий классов");
    assert.deepEqual(r.meta.check.style, []);
    assert.equal(r.needsReview, false);
  });

  it("«Разработчики»: термины остаются, но каждый объяснён «чтобы …»; без объяснения — ловится", async () => {
    const { r } = await run("dev", F.AFTER.dev);
    assert.ok(pipeline.findJargon(r.text, codeWords).length >= 2, "термины есть");
    assert.deepEqual(pipeline.jargonCheck(r.text, "dev", codeWords), [], "и все объяснены");
    assert.deepEqual(r.meta.check.style, []);
    const unexplained = F.AFTER.dev.replace(", чтобы первичную загрузку не включил случайный пользователь", "");
    assert.deepEqual(pipeline.jargonCheck(unexplained, "dev", codeWords).map((i) => i.quote).sort(), ["ADMIN", "bootstrap"]);
  });

  it("«Смешанная»: один объяснённый термин можно", async () => {
    const { r } = await run("mixed", F.AFTER.mixed);
    assert.deepEqual(r.meta.check.style, []);
    assert.deepEqual(pipeline.jargonCheck(F.DRY, "mixed", codeWords).length > 0, true);
  });

  it("первая строка не длиннее 90 символов: у заходов, у текста каждой аудитории", async () => {
    for (const a of pipeline.parseAngles(JSON.stringify({ angles: F.ANGLES })).list) assert.ok(a.hook.length <= 90, a.hook);
    for (const text of Object.values(F.AFTER)) assert.ok(text.split("\n")[0].length <= 90);
    const long = "Сводка на дашборде теперь остаётся на месте после перезапуска сервера и больше никуда не денется";
    assert.ok(long.length > 90);
    const { r, calls } = await run("users", long + "\n\nТекст.\n\nА вы?", F.AFTER.users);
    assert.match(calls.filter((c) => c.step === "write")[1].user, /заголовок длиннее 90 символов/);
    assert.ok(r.text.split("\n")[0].length <= 90);
  });

  it("выдуманные числа и «раньше было» без опоры ловятся проверкой (и остаются, если ИИ не исправил)", async () => {
    const invented = "Сводка на дашборде теперь остаётся на месте\n\nРаньше данные пропадали при каждом перезапуске, теперь загрузка в 3 раза быстрее.\n\nА вы что думаете?";
    const { r } = await run("users", invented, invented);
    const quotes = r.meta.check.issues.map((i) => i.quote);
    assert.ok(quotes.includes("3"), "выдуманное число");
    assert.ok(quotes.some((q) => q.startsWith("Раньше данные пропадали")), "«раньше было» без опоры");
    assert.equal(r.needsReview, true);
    assert.equal(r.status, "draft", "черновик с пометкой, а не публикация");
  });

  it("все три варианта проходят кодовую проверку; невыбранный с выдумкой помечен", async () => {
    const calls = [];
    const r = await pipeline.runPipeline({
      data: F.DATA, profile: { ...PROFILE, audience: "users" },
      call: fakeAi({
        facts: F.FACTS, angles: F.ANGLES, calls,
        raw: { write: JSON.stringify({ variants: [
          { angle: "a1", text: F.AFTER.users, used_facts: ["f1"] },
          { angle: "a2", text: "Как дашборд научился помнить свои данные\n\nТеперь сводка хранится в базе.\n\nЧто думаете?", used_facts: ["f1"] },
          { angle: "a3", text: "Пропадала ли у вас сводка после перезапуска?\n\nВ версии 2.0 это исправлено.\n\nА у вас?", used_facts: ["f1"] },
        ] }) },
      }),
    });
    assert.deepEqual(r.meta.variants.map((v) => v.check.status), ["ok", "unverified", "needs_review"]);
    assert.deepEqual(r.meta.variants[2].check.issues.map((i) => i.quote), ["2.0"]);
  });

  it("технический факт (сервисы) не идёт в пост для пользователей: только факты, заметные читателю", async () => {
    const { calls } = await run("users", F.AFTER.users);
    const facts = JSON.parse(calls.find((c) => c.step === "write").user.match(/<facts>\n([\s\S]*?)\n<\/facts>/)[1]);
    assert.deepEqual(facts.map((f) => f.id), ["f1", "f2"]);
  });
});

describe("Регрессия: режимы и прежние посты с профилем и заходами", () => {
  function makeCtx(mode) {
    const w = console.warn;
    console.warn = () => {};
    const channel = [];
    const ctx = {
      ...tenantDb(":memory:", "fixture-key"),
      aiCall: fakeAi({ facts: F.FACTS, angles: F.ANGLES, raw: { write: variantsOf(F.AFTER.users) } }),
      TG_BOT_TOKEN: "1:a",
      gh: async () => ({ ok: true, status: 200, json: async () => [
        { sha: F.SHA, commit: { message: "feat(pms): add durable dashboard persistence" }, parents: [{ sha: "0".repeat(40) }] },
        { sha: "0".repeat(40), commit: { message: "base" }, parents: [] },
      ] }),
      buildInputData: async () => ({ text: "вход", files: F.DATA.files }),
      tg: async (m, body) => (body.chat_id === "@chan" && channel.push(body), { ok: true, result: { message_id: 1 } }),
    };
    console.warn = w;
    for (const [k, v] of Object.entries({ repo: "me/pms", github_token: "t", channel_id: "@chan", tg_owner_chat_id: "42", ai_key: "k", ai_model: "m", debounce: "0", mode, last_sha: "0".repeat(40), audience: "users", cta: "question", last_digest_date: "2000-01-01", digest_time: "00:00" })) ctx.set(k, v);
    ctx.tg = channelAdmin(ctx.tg);
    return { ctx, channel };
  }

  it("approve — черновик с тремя вариантами; auto — публикация выбранного с жирным заголовком; digest — дайджест", async () => {
    const a = makeCtx("approve");
    const ra = await poster.check(true, a.ctx, { silent: true });
    const pa = a.ctx.post(ra.posts[0].id);
    assert.equal(pa.status, "draft");
    assert.equal(JSON.parse(pa.meta).variants.length, 3);
    assert.equal(a.channel.length, 0);

    const b = makeCtx("auto");
    const rb = await poster.check(true, b.ctx, { silent: true });
    const pb = b.ctx.post(rb.posts[0].id);
    assert.equal(pb.status, "sent");
    // Текст с подписью от кода; жирный — только заголовок (подзаголовков в этом тексте нет, подпись не жирная)
    const footer = JSON.parse(pb.meta).footer;
    assert.match(footer, /GitHub: https:\/\/github\.com\/me\/pms\//);
    assert.equal(b.channel[0].text, F.AFTER.users + "\n\n" + footer);
    assert.deepEqual(b.channel[0].entities, [{ type: "bold", offset: 0, length: F.AFTER.users.split("\n")[0].length }]);

    const d = makeCtx("digest");
    const rd = await poster.check(true, d.ctx, { silent: true });
    assert.equal(d.ctx.post(rd.posts[0].id).kind, "digest");
    assert.equal(d.ctx.post(rd.posts[0].id).status, "draft");
  });
});
