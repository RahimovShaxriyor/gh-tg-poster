const { describe, it, beforeEach } = require("node:test");
const { postAi } = require("./helpers/fake-ai");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/db");
const { handleUpdate, runCheckCommand } = require("../lib/telegram-bot");
const { textHash } = require("../lib/notify");
const { waitIdle } = require("../lib/poster");
const { tenantDb, channelAdmin } = require("./helpers/tenant");

const OWNER = 111;
const STRANGER = 222;
const TOKEN = "123:abc";

const commit = (sha, msg = "feat: " + sha) => ({
  sha,
  parents: [{}],
  commit: { message: msg, committer: { date: "2026-10-20T10:05:00Z" } },
});

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Бот в личке: команды /check, /status, /help и кнопки", () => {
  let ctx;
  let calls;
  let commits;
  let aiAnswer;
  let channel;

  beforeEach(() => {
    calls = [];
    channel = [];
    commits = [commit("aaaaaaa1111")];
    aiAnswer = async () => "Новый анонс";
    const { log, warn } = console;
    console.log = () => {};
    console.warn = () => {};
    ctx = {
      ...tenantDb(":memory:", "bot-test-key"),
      // Бот один на платформу: токен из окружения, а не из настроек аккаунта
      TG_BOT_TOKEN: TOKEN,
      tg: async (method, body) => {
        calls.push({ method, body });
        if (method === "sendMessage" && body.chat_id === "@chan") {
          channel.push(body.text);
          return { ok: true, result: { message_id: 500 + channel.length } };
        }
        return { ok: true, result: { message_id: 1 } };
      },
      gh: async () => ({ ok: true, status: 200, json: async () => commits }),
      aiCall: postAi((...args) => aiAnswer(...args)),
      buildInput: async (r, b, h, msgs) => "Коммиты:\n" + msgs.join("\n"),
    };
    console.log = log;
    console.warn = warn;
    for (const [k, v] of Object.entries({
      tg_owner_chat_id: String(OWNER), channel_id: "@chan",
      repo: "me/repo", branch: "main", github_token: "t", ai_key: "k", ai_model: "m",
      debounce: "60", digest_tz: "Europe/Moscow",
    })) ctx.set(k, v);
    ctx.tg = channelAdmin(ctx.tg);
    process.env.DOMAIN = "poster.example.org";
  });

  const msg = (from, text) => ({
    message: { chat: { id: from, type: "private" }, from: { id: from, username: "u" + from }, text },
  });
  const press = (from, data, extra = {}) => ({
    callback_query: { id: "cb" + Math.random(), from: { id: from }, data, message: { message_id: 77, chat: { id: from }, text: "Черновик" }, ...extra },
  });
  const ownerMessages = () => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === String(OWNER));
  const addDraft = (text = "Текст черновика", extra = "") =>
    Number(ctx.db.prepare(`insert into posts(user_id,head,input,text,status${extra ? "," + extra.split("=")[0] : ""}) values(1,'h','вход',?,'draft'${extra ? "," + extra.split("=")[1] : ""})`).run(text).lastInsertRowid);

  it("чужому бот не отвечает ни на одну команду и ничего не запускает", async () => {
    for (const text of ["/help", "/status", "/check", "/start", "привет"]) {
      await handleUpdate(msg(STRANGER, text), ctx, TOKEN);
    }
    await waitIdle(500);
    assert.deepEqual(calls, []);
    assert.equal(ctx.get("last_check"), "");
  });

  it("/help владельцу: список команд", async () => {
    await handleUpdate(msg(OWNER, "/help"), ctx, TOKEN);
    const text = ownerMessages()[0].body.text;
    for (const cmd of ["/check", "/status", "/help"]) assert.match(text, new RegExp(cmd));
  });

  it("/status: репозиторий, ветка, режим, последняя проверка, черновики, канал", async () => {
    addDraft();
    addDraft();
    ctx.set("last_check", "2026-10-20T10:05:00Z");
    await handleUpdate(msg(OWNER, "/status"), ctx, TOKEN);
    const text = ownerMessages()[0].body.text;
    assert.match(text, /me\/repo, ветка main/);
    assert.match(text, /Режим: черновики, публикация по кнопке/);
    assert.match(text, /Последняя проверка: 20 окт\.?,? 13:05/);
    assert.match(text, /Черновиков ждёт: 2/);
    assert.match(text, /Канал: подключён \(@chan\)/);
  });

  it("/status без канала и до первой проверки", async () => {
    ctx.set("channel_id", "");
    await handleUpdate(msg(OWNER, "/status@my_bot"), ctx, TOKEN);
    const text = ownerMessages()[0].body.text;
    assert.match(text, /Последняя проверка: ещё не было/);
    assert.match(text, /Канал: не подключён/);
  });

  it("/check без новых коммитов: короткий ответ с последним коммитом и датой", async () => {
    ctx.set("last_sha", "aaaaaaa1111");
    await handleUpdate(msg(OWNER, "/check"), ctx, TOKEN);
    await waitFor(() => ownerMessages().length === 1);
    assert.match(ownerMessages()[0].body.text, /^Новых коммитов нет\. Последний: aaaaaaa, 20 окт\.?,? 13:05$/);
  });

  it("/check с новыми коммитами игнорирует паузу и присылает черновик с тремя кнопками и ссылкой на панель", async () => {
    ctx.set("last_sha", "aaaaaaa1111");
    ctx.set("tg_notify_drafts", "1"); // уведомление не должно прийти вторым сообщением
    commits = [commit("bbbbbbb2222"), commit("aaaaaaa1111")];
    await handleUpdate(msg(OWNER, "/check"), ctx, TOKEN);
    await waitFor(() => ownerMessages().length >= 1);
    await waitIdle(500);

    assert.equal(ownerMessages().length, 1);
    const { text, reply_markup } = ownerMessages()[0].body;
    assert.match(text, /Новый анонс/);
    assert.match(text, /https:\/\/poster\.example\.org/);
    const buttons = reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(buttons, ["Опубликовать", "Другой вариант", "Отклонить"]);
    assert.equal(channel.length, 0, "сам пост в канал не уходит");
  });

  it("/check: первый запуск, ошибка GitHub, ИИ счёл неинтересным — по одному понятному сообщению", async () => {
    let out = [];
    const send = async (p) => out.push(p);

    await runCheckCommand(ctx, send);
    assert.match(out[0].text, /запомнил последний коммит: aaaaaaa/);

    out = [];
    ctx.gh = async () => ({ ok: false, status: 401, headers: new Headers() });
    await runCheckCommand(ctx, send);
    assert.match(out[0].text, /Не удалось проверить GitHub: GitHub вернул 401/);
    assert.equal(ownerMessages().length, 0, "фоновое уведомление об ошибке не дублирует ответ");

    out = [];
    ctx.gh = async () => ({ ok: true, json: async () => [commit("c3"), commit("aaaaaaa1111")] });
    aiAnswer = async () => "SKIP";
    await runCheckCommand(ctx, send);
    assert.equal(out.length, 1);
    assert.match(out[0].text, /неинтересны/);
    assert.equal(out[0].reply_markup.inline_keyboard[0][0].text, "Всё равно написать");
  });

  it("/check, пока идёт другая проверка: просит подождать", async () => {
    let release;
    ctx.gh = () => new Promise((r) => (release = () => r({ ok: true, json: async () => [] })));
    const out = [];
    const first = runCheckCommand(ctx, async (p) => out.push(p));
    await runCheckCommand(ctx, async (p) => out.push(p));
    assert.match(out[0].text, /Проверка уже идёт/);
    release();
    await first;
  });

  it("«Опубликовать»: пост уходит в канал один раз, повторное нажатие ничего не публикует", async () => {
    const id = addDraft("Анонс");
    const data = `pub:${id}:${textHash("Анонс")}`;
    await handleUpdate(press(OWNER, data), ctx, TOKEN);
    await handleUpdate(press(OWNER, data), ctx, TOKEN);
    assert.deepEqual(channel, ["Анонс"]);
    assert.equal(ctx.post(id).status, "sent");
    const answers = calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body);
    assert.equal(answers[0].text, "Опубликовано в канал.");
    assert.match(answers[1].text, /уже отправляется или уже был отправлен/);
    assert.equal(answers[1].show_alert, true);
  });

  it("одновременные нажатия «Опубликовать» в боте и в панели дают одно сообщение в канале", async () => {
    const id = addDraft("Анонс");
    const { publish } = require("../lib/poster");
    const results = await Promise.allSettled([
      handleUpdate(press(OWNER, `pub:${id}:${textHash("Анонс")}`), ctx, TOKEN),
      publish(id, null, ctx),
    ]);
    assert.equal(results.filter((r) => r.status === "rejected").length <= 1, true);
    assert.equal(channel.length, 1);
  });

  it("если текст изменился после сообщения, кнопка не публикует, а присылает актуальный черновик", async () => {
    const id = addDraft("Новый текст после правки");
    await handleUpdate(press(OWNER, `pub:${id}:${textHash("Старый текст")}`), ctx, TOKEN);
    assert.equal(channel.length, 0);
    assert.equal(ctx.post(id).status, "draft");
    assert.match(ownerMessages().at(-1).body.text, /Новый текст после правки/);
  });

  it("прерванная отправка: кнопка сначала просит проверить канал, публикует только «Отправить ещё раз»", async () => {
    const id = addDraft("Анонс");
    ctx.db.prepare("update posts set status='failed', interrupted=1 where id=?").run(id);
    await handleUpdate(press(OWNER, `pub:${id}:${textHash("Анонс")}`), ctx, TOKEN);
    assert.equal(channel.length, 0);
    const confirm = ownerMessages().at(-1).body;
    assert.match(confirm.text, /мог уже появиться в канале/);
    const again = confirm.reply_markup.inline_keyboard[0][0].callback_data;
    assert.match(again, /^pubf:/);
    await handleUpdate(press(OWNER, again), ctx, TOKEN);
    assert.equal(channel.length, 1);
  });

  it("«Другой вариант»: сообщение обновляется новым текстом, пока ИИ пишет — публиковать нельзя", async () => {
    const id = addDraft("Старый");
    let release;
    aiAnswer = () => new Promise((r) => (release = () => r("Свежий вариант")));
    await handleUpdate(press(OWNER, `regen:${id}`), ctx, TOKEN);
    assert.equal(ctx.post(id).status, "generating");

    await handleUpdate(press(OWNER, `pub:${id}:${textHash("Старый")}`), ctx, TOKEN);
    assert.equal(channel.length, 0);

    // Шаг написания начинается после фактов и захода: ждём, пока ИИ начнёт писать текст
    await waitFor(() => typeof release === "function");
    release();
    await waitIdle(1000);
    await waitFor(() => calls.filter((c) => c.method === "editMessageText").length >= 2);
    const lastEdit = calls.filter((c) => c.method === "editMessageText").at(-1).body;
    assert.match(lastEdit.text, /Свежий вариант/);
    assert.equal(lastEdit.reply_markup.inline_keyboard[0][0].callback_data, `pub:${id}:${textHash("Свежий вариант")}`);
    assert.equal(ctx.post(id).status, "draft");
  });

  it("«Отклонить»: черновик отклоняется, повторное нажатие сообщает, что пост уже обработан", async () => {
    const id = addDraft();
    // «Отклонить» — опасное действие: сначала подтверждение с одноразовой кнопкой
    await handleUpdate(press(OWNER, `rej:${id}`), ctx, TOKEN);
    assert.equal(ctx.post(id).status, "draft", "без подтверждения ничего не меняется");
    const ask = ownerMessages().at(-1).body;
    assert.match(ask.text, /Отклонить пост #\d+\?[\s\S]*60 секунд/);
    const yes = ask.reply_markup.inline_keyboard[0][0].callback_data;
    await handleUpdate(press(OWNER, yes), ctx, TOKEN);
    assert.equal(ctx.post(id).status, "rejected");
    // Повтор того же подтверждения и новая кнопка «Отклонить» ничего не делают
    await handleUpdate(press(OWNER, yes), ctx, TOKEN);
    assert.match(calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body.text, /Уже выполнено/);
    await handleUpdate(press(OWNER, `rej:${id}`), ctx, TOKEN);
    const last = calls.filter((c) => c.method === "answerCallbackQuery").at(-1).body;
    assert.match(last.text, /уже обработан/);
  });

  it("кнопки чужого пользователя ничего не меняют", async () => {
    const id = addDraft("Анонс");
    for (const data of [`pub:${id}:${textHash("Анонс")}`, `regen:${id}`, `rej:${id}`]) {
      await handleUpdate(press(STRANGER, data), ctx, TOKEN);
    }
    assert.equal(ctx.post(id).status, "draft");
    assert.equal(channel.length, 0);
    assert.equal(calls.every((c) => c.method === "answerCallbackQuery" && !c.body.text), true);
  });
});
