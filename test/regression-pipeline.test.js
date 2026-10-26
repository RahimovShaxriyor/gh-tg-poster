const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/db");
const poster = require("../lib/poster");
const { fakeAi } = require("./helpers/fake-ai");

// Регрессия: режимы работают как до конвейера, но текст пишется в три шага
const BASE = "0".repeat(40);
const HEAD = "1".repeat(40);
const LIST = [
  { sha: HEAD, commit: { message: "feat: экспорт в Markdown" }, parents: [{ sha: BASE }] },
  { sha: BASE, commit: { message: "base" }, parents: [] },
];

function makeCtx(aiCall, mode) {
  const w = console.warn;
  console.warn = () => {};
  const db = createDatabase(":memory:", "regress-key");
  console.warn = w;
  const channel = [];
  const owner = [];
  const ctx = {
    ...db,
    aiCall,
    TG_BOT_TOKEN: "1:a",
    gh: async () => ({ ok: true, status: 200, json: async () => LIST }),
    buildInput: async (r, b, h, msgs) => "Коммиты:\n" + msgs.join("\n"),
    tg: async (method, body) => {
      if (method === "sendMessage") (body.chat_id === "@chan" ? channel : owner).push(body);
      return { ok: true, result: { message_id: 1 } };
    },
  };
  for (const [k, v] of Object.entries({
    repo: "me/repo", github_token: "t", channel_id: "@chan", ai_key: "k", ai_model: "m",
    debounce: "0", mode, last_sha: BASE, tg_owner_chat_id: "42", tg_notify_drafts: "1",
    last_digest_date: "2000-01-01", digest_time: "00:00",
  })) ctx.set(k, v);
  return { ctx, channel, owner };
}

describe("Регрессия режимов с конвейером", () => {
  it("approve: черновик с фактами, владелец получает черновик с кнопками, в канал ничего", async () => {
    const calls = [];
    const { ctx, channel, owner } = makeCtx(fakeAi({ text: "Появился экспорт в Markdown", calls }), "approve");
    const res = await poster.check(true, ctx);
    assert.equal(res.status, "created");
    const p = ctx.post(res.posts[0].id);
    assert.equal(p.status, "draft");
    assert.equal(p.text, "Появился экспорт в Markdown");
    assert.deepEqual(calls.map((c) => c.step), ["facts", "angles", "write", "verify"]);
    assert.match(calls[0].user, /- \[1111111\] feat: экспорт в Markdown/);
    assert.equal(channel.length, 0);
    assert.equal(owner[0].reply_markup.inline_keyboard[0][0].text, "Опубликовать");
  });

  it("auto: проверенный текст уходит в канал", async () => {
    const { ctx, channel } = makeCtx(fakeAi({ text: "Появился экспорт в Markdown" }), "auto");
    const res = await poster.check(true, ctx);
    const p = ctx.post(res.posts[0].id);
    assert.equal(p.status, "sent");
    // В канал — текст и подпись от кода (дата коммитов, ссылка, хештеги); в базе — только текст
    const footer = JSON.parse(p.meta).footer;
    assert.match(footer, /https:\/\/github\.com\/me\/repo\//);
    assert.deepEqual(channel.map((m) => m.text), ["Появился экспорт в Markdown\n\n" + footer]);
    assert.equal(p.text, "Появился экспорт в Markdown");
  });

  it("auto: пустой ответ на шаге написания — failed (не skipped), в канал ничего, владельцу сообщение", async () => {
    const { ctx, channel, owner } = makeCtx(fakeAi({ text: null }), "auto");
    const res = await poster.check(true, ctx);
    const p = ctx.post(res.posts[0].id);
    assert.equal(p.status, "failed");
    assert.equal(p.error, "ИИ вернул пустой ответ");
    assert.equal(channel.length, 0);
    assert.match(owner.at(-1).text, /Не удалось подготовить пост/);
  });

  it("auto: ИИ счёл неинтересным — skipped, в канал ничего", async () => {
    const { ctx, channel } = makeCtx(fakeAi({ text: "SKIP" }), "auto");
    const res = await poster.check(true, ctx);
    assert.equal(ctx.post(res.posts[0].id).status, "skipped");
    assert.equal(channel.length, 0);
  });

  it("digest: пост kind=digest, шаг написания с промптом дайджеста", async () => {
    const calls = [];
    const { ctx } = makeCtx(fakeAi({ text: "Итоги дня: экспорт в Markdown", calls }), "digest");
    const res = await poster.check(true, ctx);
    const p = ctx.post(res.posts[0].id);
    assert.equal(p.kind, "digest");
    assert.equal(p.status, "draft");
    assert.match(calls.find((c) => c.step === "write").system, /дайджест изменений за день/);
  });

  it("строгая проверка выключена в настройках — без вызова проверки", async () => {
    const calls = [];
    const { ctx } = makeCtx(fakeAi({ text: "Появился экспорт", calls }), "approve");
    ctx.set("strict_check", "0");
    await poster.check(true, ctx);
    assert.deepEqual(calls.map((c) => c.step), ["facts", "angles", "write"]);
  });
});
