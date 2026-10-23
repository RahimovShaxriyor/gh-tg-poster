const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { handleUpdate } = require("../lib/telegram-bot");
const { draftMessage, textHash } = require("../lib/notify");

const META = JSON.stringify({
  facts: [], used_facts: [],
  check: { status: "needs_review", issues: [{ quote: "в 2 раза быстрее", reason: "нет в фактах", source: "ai" }] },
});

function makeCtx() {
  const w = console.warn;
  console.warn = () => {};
  const db = createDatabase(":memory:", "review-key");
  console.warn = w;
  const calls = [];
  const ctx = {
    ...db,
    ADMIN_PASSWORD: "review-pass",
    SESSION_SECRET: "s".repeat(40),
    TG_BOT_TOKEN: "1:a",
    tg: async (method, body) => {
      calls.push({ method, body });
      return { ok: true, result: { message_id: 9 } };
    },
  };
  ctx.set("channel_id", "@chan");
  ctx.set("tg_owner_chat_id", "42");
  return { ctx, calls };
}

const addPost = (ctx, needsReview) =>
  Number(ctx.db.prepare("insert into posts(head,input,text,status,meta,needs_review) values('h','i','Стало в 2 раза быстрее','draft',?,?)")
    .run(needsReview ? META : null, needsReview ? 1 : 0).lastInsertRowid);

describe("Публикация текста с непроверенными утверждениями", () => {
  let server;
  let base;
  let cookie;
  let ctx;
  let calls;

  before(async () => {
    ({ ctx, calls } = makeCtx());
    server = http.createServer(createApp(ctx));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "review-pass" }) });
    cookie = login.headers.get("set-cookie").split(";")[0];
  });
  after(() => new Promise((r) => server.close(r)));
  beforeEach(() => (calls.length = 0));

  const publish = (id, body) => fetch(`${base}/api/posts/${id}/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("без подтверждения — 409 needs_review и ничего не отправлено; с подтверждением — опубликован", async () => {
    const id = addPost(ctx, true);
    const first = await publish(id, {});
    assert.equal(first.status, 409);
    assert.equal((await first.json()).code, "needs_review");
    assert.equal(calls.length, 0);
    assert.equal(ctx.post(id).status, "draft");

    const second = await publish(id, { confirm_unverified: true });
    assert.equal(second.status, 200);
    assert.equal(ctx.post(id).status, "sent");
    assert.equal(calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === "@chan").length, 1);
  });

  it("проверенный пост публикуется как раньше, без подтверждения", async () => {
    const id = addPost(ctx, false);
    assert.equal((await publish(id, {})).status, 200);
    assert.equal(ctx.post(id).status, "sent");
  });

  it("в /api/state у поста есть meta и needs_review для панели", async () => {
    const id = addPost(ctx, true);
    const state = await (await fetch(`${base}/api/state?limit=100`, { headers: { cookie } })).json();
    const p = state.posts.find((x) => x.id === id);
    assert.equal(p.needs_review, 1);
    assert.equal(JSON.parse(p.meta).check.issues[0].quote, "в 2 раза быстрее");
  });
});

describe("Бот: черновик с непроверенными утверждениями", () => {
  it("в сообщении — предупреждение с фразами, кнопка «Опубликовать» ведёт на подтверждение", () => {
    const { ctx } = makeCtx();
    const id = addPost(ctx, true);
    const msg = draftMessage(ctx.post(id), ctx);
    assert.match(msg.text, /⚠️ Требует проверки: замечаний 1 — «в 2 раза быстрее»/);
    assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, `pubc:${id}:${textHash("Стало в 2 раза быстрее")}`);

    const plain = draftMessage(ctx.post(addPost(ctx, false)), ctx);
    assert.equal(plain.text.includes("Требует проверки"), false);
    assert.match(plain.reply_markup.inline_keyboard[0][0].callback_data, /^pub:/);
  });

  it("pubc не публикует, а спрашивает ещё раз; «Да, опубликовать» публикует", async () => {
    const { ctx, calls } = makeCtx();
    const id = addPost(ctx, true);
    const hash = textHash("Стало в 2 раза быстрее");
    const press = (data) => handleUpdate({ callback_query: { id: "cb", from: { id: 42 }, data, message: { message_id: 5, chat: { id: 42 }, text: "Черновик" } } }, ctx, "1:a");

    await press(`pubc:${id}:${hash}`);
    assert.equal(ctx.post(id).status, "draft");
    const ask = calls.find((c) => c.method === "sendMessage" && c.body.chat_id === "42");
    assert.match(ask.body.text, /есть непроверенные утверждения/);
    const yes = ask.body.reply_markup.inline_keyboard[0][0];
    assert.equal(yes.text, "Да, опубликовать");
    assert.equal(yes.callback_data, `pub:${id}:${hash}`);

    await press(yes.callback_data);
    assert.equal(ctx.post(id).status, "sent");
  });
});
