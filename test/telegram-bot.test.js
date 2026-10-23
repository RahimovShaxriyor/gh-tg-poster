const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/db");
const { createOwnerCode, handleUpdate } = require("../lib/telegram-bot");

describe("Telegram-бот: привязка владельца и канала, кнопки", () => {
  let ctx;
  let calls;

  beforeEach(() => {
    calls = [];
    ctx = {
      ...createDatabase(":memory:", "tg-test-key"),
      tg: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage" && body.chat_id === "@chan") {
          return { ok: true, result: { message_id: 42 } };
        }
        return { ok: true, result: true };
      },
    };
    ctx.set("tg_token", "123:abc");
  });

  const startMsg = (chatId, text, username = "owner") => ({
    message: { chat: { id: chatId, type: "private" }, from: { id: chatId, username }, text },
  });

  it("/start без кода не делает отправителя владельцем", async () => {
    await handleUpdate(startMsg(111, "/start"), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "");
    assert.match(calls[0].body.text, /получите код в панели/);
  });

  it("/start с неверным кодом не привязывает, с верным привязывает, код одноразовый", async () => {
    const { code } = createOwnerCode(ctx);

    await handleUpdate(startMsg(222, "/start deadbeef0000", "stranger"), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "");

    await handleUpdate(startMsg(111, `/start ${code}`), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "111");
    assert.equal(ctx.get("tg_owner_username"), "@owner");

    // Повторное использование того же кода другим пользователем не работает
    await handleUpdate(startMsg(222, `/start ${code}`, "stranger"), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "111");
  });

  it("истёкший код не принимается", async () => {
    const { code } = createOwnerCode(ctx);
    ctx.set("tg_owner_code_exp", String(Date.now() - 1000));
    await handleUpdate(startMsg(111, `/start ${code}`), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "");
  });

  const addedToChannel = (fromId, chatId = -100777) => ({
    my_chat_member: {
      chat: { id: chatId, type: "channel" },
      from: { id: fromId },
      new_chat_member: { status: "administrator" },
    },
  });

  it("канал привязывается автоматически, только если бота добавил владелец", async () => {
    await handleUpdate(addedToChannel(555), ctx, "123:abc");
    assert.equal(ctx.get("channel_id"), "", "владелец не привязан: не привязываем");

    ctx.set("tg_owner_chat_id", "111");
    await handleUpdate(addedToChannel(555), ctx, "123:abc");
    assert.equal(ctx.get("channel_id"), "", "добавил чужой: не привязываем");

    await handleUpdate(addedToChannel(111), ctx, "123:abc");
    assert.equal(ctx.get("channel_id"), "-100777");

    await handleUpdate(addedToChannel(111, -100888), ctx, "123:abc");
    assert.equal(ctx.get("channel_id"), "-100777", "уже заданный канал не перезаписывается");
  });

  it("кнопка «Опубликовать» от не-владельца отклоняется, от владельца публикует", async () => {
    ctx.set("tg_owner_chat_id", "111");
    ctx.set("channel_id", "@chan");
    const id = ctx.db.prepare("insert into posts(status, text) values('draft', 'Текст')").run().lastInsertRowid;

    await handleUpdate({ callback_query: { id: "cb1", from: { id: 222 }, data: `pub:${id}` } }, ctx, "123:abc");
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(calls.at(-1).method, "answerCallbackQuery");
    assert.equal(calls.at(-1).body.show_alert, true);

    await handleUpdate({ callback_query: { id: "cb2", from: { id: 111 }, data: `pub:${id}` } }, ctx, "123:abc");
    assert.equal(ctx.post(id).status, "sent");
    assert.equal(ctx.post(id).tg_message_id, 42);
  });
});
