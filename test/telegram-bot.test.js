const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/db");
const { handleUpdate, OWNER_CODE_TTL_MS } = require("../lib/telegram-bot");
const { tenantDb, channelAdmin } = require("./helpers/tenant");

describe("Telegram-бот: привязка владельца и канала, кнопки", () => {
  let ctx;
  let calls;

  beforeEach(() => {
    calls = [];
    ctx = {
      ...tenantDb(":memory:", "tg-test-key"),
      TG_BOT_TOKEN: "123:abc",
      tg: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage" && body.chat_id === "@chan") {
          return { ok: true, result: { message_id: 42 } };
        }
        return { ok: true, result: true };
      },
    };
    ctx.tg = channelAdmin(ctx.tg);
  });
  // Код привязки выдаёт платформа для конкретного аккаунта (в базе — только его хеш)
  const createOwnerCode = (c, ttl = OWNER_CODE_TTL_MS) => c.platform.createTgLinkCode(c.userId, ttl);

  const startMsg = (chatId, text, username = "owner") => ({
    message: { chat: { id: chatId, type: "private" }, from: { id: chatId, username }, text },
  });

  it("/start без кода не делает отправителя владельцем, и бот ему не отвечает", async () => {
    await handleUpdate(startMsg(111, "/start"), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "");
    assert.deepEqual(calls, []);
  });

  it("/start с неверным кодом не привязывает, с верным привязывает, код одноразовый", async () => {
    const { code } = createOwnerCode(ctx);

    await handleUpdate(startMsg(222, "/start deadbeef0000", "stranger"), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "");

    await handleUpdate(startMsg(111, `/start ${code}`), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "111");
    assert.equal(ctx.get("tg_owner_username"), "@owner");
    // После привязки — меню команд только для лички владельца
    const reg = calls.find((c) => c.method === "setMyCommands");
    assert.deepEqual(reg.body.scope, { type: "chat", chat_id: 111 });
    const names = reg.body.commands.map((c) => c.command);
    for (const c of ["check", "status", "help", "drafts", "commits", "pause", "resume", "unbind", "health"]) assert.ok(names.includes(c), c);
    // Описания на русском и в пределах ограничений Telegram (3–256 символов, имя — a-z, 0-9, _)
    for (const c of reg.body.commands) {
      assert.match(c.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(c.description.length >= 3 && c.description.length <= 256 && /[а-я]/i.test(c.description), c.command);
    }

    // Повторное использование того же кода другим пользователем не работает
    await handleUpdate(startMsg(222, `/start ${code}`, "stranger"), ctx, "123:abc");
    assert.equal(ctx.get("tg_owner_chat_id"), "111");
  });

  it("истёкший код не принимается", async () => {
    const { code } = createOwnerCode(ctx, -1000);
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
    const id = ctx.db.prepare("insert into posts(user_id,status, text) values(1,'draft', 'Текст')").run().lastInsertRowid;

    await handleUpdate({ callback_query: { id: "cb1", from: { id: 222 }, data: `pub:${id}` } }, ctx, "123:abc");
    assert.equal(ctx.post(id).status, "draft");
    // Чужому — только пустой ответ на нажатие (гасит «загрузку»), без текста и сообщений
    assert.deepEqual(calls, [{ method: "answerCallbackQuery", body: { callback_query_id: "cb1" } }]);

    await handleUpdate({ callback_query: { id: "cb2", from: { id: 111 }, data: `pub:${id}` } }, ctx, "123:abc");
    assert.equal(ctx.post(id).status, "sent");
    assert.equal(ctx.post(id).tg_message_id, 42);
  });
});
