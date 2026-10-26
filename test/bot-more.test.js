const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDatabase } = require("../lib/db");
const { handleUpdate, OWNER_CODE_TTL_MS } = require("../lib/telegram-bot");
const commands = require("../lib/bot-commands");
const poster = require("../lib/poster");
const { clearCommitsCache } = require("../lib/commits");
const { fakeAi } = require("./helpers/fake-ai");
const { tenantDb } = require("./helpers/tenant");

const OWNER = 111;
const STRANGER = 222;
const TOKEN = "123:abc";
const sha = (c) => c.repeat(40);

const ghCommit = (s, msg, hoursAgo = 1) => ({
  sha: s, parents: [{}], author: { login: "anna" },
  commit: { message: msg, author: { name: "anna", date: new Date(Date.now() - hoursAgo * 3600e3).toISOString() } },
});

async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Бот: расширенные команды", () => {
  let ctx;
  let calls;
  let gh;

  beforeEach(() => {
    commands.resetRateLimit();
    clearCommitsCache();
    calls = [];
    gh = {
      commits: [ghCommit(sha("a"), "feat: экспорт в Markdown", 2), ghCommit(sha("b"), "fix: поиск", 30), ghCommit(sha("c"), "docs: README", 24 * 10)],
      branches: [{ name: "main", protected: true }, { name: "dev", protected: false }],
      repos: [{ full_name: "me/repo", default_branch: "main" }, { full_name: "me/other", default_branch: "trunk" }],
    };
    const json = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });
    const { log, warn } = console;
    console.log = () => {};
    console.warn = () => {};
    ctx = {
      ...tenantDb(":memory:", "bot-more-key"),
      TG_BOT_TOKEN: TOKEN,
      tg: async (method, body) => {
        calls.push({ method, body });
        if (method === "getMe") return { ok: true, result: { id: 9, username: "poster_bot" } };
        if (method === "getChatMember") return { ok: true, result: { status: "administrator", can_post_messages: true } };
        return { ok: true, result: { message_id: 500 + calls.length } };
      },
      gh: async (p) => {
        if (p.includes("/branches")) return json(gh.branches);
        if (p.includes("/user/repos")) return json(gh.repos);
        const one = p.match(/\/commits\/([0-9a-f]+)$/);
        if (one) {
          const c = gh.commits.find((x) => x.sha.startsWith(one[1]));
          return c ? json({ ...c, files: [{ filename: "src/export.js", status: "added", additions: 40, deletions: 2, patch: "+x" }, { filename: "package-lock.json", additions: 1, deletions: 1 }] }) : json({ message: "Not Found" }, 404);
        }
        if (p.includes("/commits?")) return json(gh.commits);
        return json({});
      },
      aiCall: fakeAi({}),
    };
    console.log = log;
    console.warn = warn;
    for (const [k, v] of Object.entries({
      tg_owner_chat_id: String(OWNER), tg_owner_username: "@owner", channel_id: "@chan", repo: "me/repo", branch: "main",
      github_token: "t", ai_key: "sk-secret-key", ai_model: "claude-sonnet-5-5", digest_tz: "UTC", mode: "approve",
    })) ctx.set(k, v);
  });

  const msg = (from, text) => ({ message: { chat: { id: from, type: "private" }, from: { id: from, username: "u" + from }, text } });
  const press = (data, from = OWNER) => ({ callback_query: { id: "cb" + Math.random(), from: { id: from }, data, message: { message_id: 77, chat: { id: from }, text: "сообщение" } } });
  const say = (text, from = OWNER) => handleUpdate(msg(from, text), ctx, TOKEN);
  const click = (data, from = OWNER) => handleUpdate(press(data, from), ctx, TOKEN);
  const sent = () => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === String(OWNER)).map((c) => c.body);
  const lastSent = () => sent().at(-1);
  const edits = () => calls.filter((c) => c.method === "editMessageText").map((c) => c.body);
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body);
  const buttons = (m) => (m.reply_markup?.inline_keyboard || []).flat();
  const addPost = (status = "draft", text = "Заголовок\n\nТекст", extra = {}) => {
    const cols = ["user_id", "head", "input", "text", "status", ...Object.keys(extra)];
    const vals = [ctx.userId, "h", "вход", text, status, ...Object.values(extra)];
    return Number(ctx.db.prepare(`insert into posts(${cols.join(",")}) values(${cols.map(() => "?").join(",")})`).run(...vals).lastInsertRowid);
  };
  const confirmYes = (m) => buttons(m).find((b) => b.callback_data.startsWith("ok:")).callback_data;

  it("чужому — ни одного ответа ни на одну новую команду и кнопку", async () => {
    for (const c of commands.COMMANDS) await say("/" + c.command + " 1", STRANGER);
    for (const data of ["dl:1", "po:1:0", "mk:" + sha("a"), "sel", "cs:0", "cc", "br:0", "rp:0", "ai", "ch", "ct", "ok:abcdef", "tn:1:shorter", "dc:1"]) await click(data, STRANGER);
    assert.equal(calls.filter((c) => c.method !== "answerCallbackQuery").length, 0);
    assert.ok(answers().every((a) => !a.text));
  });

  it("каждая команда из меню отвечает владельцу понятным сообщением", async () => {
    for (const c of commands.COMMANDS.filter((x) => x.command !== "check")) {
      const before = calls.length;
      await say("/" + c.command);
      assert.ok(calls.slice(before).some((x) => x.method === "sendMessage" && x.body.text), c.command);
    }
  });

  it("/help сгруппирован по смыслу и с примерами", async () => {
    await say("/help");
    const t = lastSent().text;
    assert.match(t, /^Посты:\n\/drafts — /);
    assert.match(t, /\nКоммиты:\n/);
    assert.match(t, /\nСостояние и управление:\n/);
    assert.match(t, /\/regen — Другой вариант черновика \(\/regen 12 короче\)/);
  });

  it("неизвестная команда — подсказка /help; лимит 30 команд в минуту", async () => {
    await say("/foo");
    assert.match(lastSent().text, /\/help — список команд/);
    for (let i = 0; i < 29; i++) await say("/panel");
    await say("/panel");
    assert.match(lastSent().text, /не больше 30 в минуту/);
    const n = sent().length;
    await say("/panel");
    assert.equal(sent().length, n, "дальше молчит до конца минуты");
  });

  describe("Посты", () => {
    it("/drafts: по 5, пагинация редактирует то же сообщение, «Открыть» — пост с кнопкой возврата", async () => {
      const ids = Array.from({ length: 12 }, (_, i) => addPost("draft", `Черновик ${i + 1}`));
      await say("/drafts");
      const first = lastSent();
      assert.match(first.text, /^Черновики: 12 · страница 1 из 3/);
      assert.deepEqual(buttons(first).filter((b) => b.text.startsWith("Открыть")).map((b) => b.text), ids.slice(-5).reverse().map((id) => `Открыть #${id}`));
      assert.ok(buttons(first).some((b) => b.callback_data === "dl:1"));
      await click("dl:2");
      const page3 = edits().at(-1);
      assert.match(page3.text, /страница 3 из 3/);
      assert.equal(page3.message_id, 77);
      assert.equal(buttons(page3).filter((b) => b.text.startsWith("Открыть")).length, 2);
      await click(`po:${ids[0]}:2`);
      const view = edits().at(-1);
      assert.match(view.text, new RegExp(`^Пост #${ids[0]} · черновик`));
      assert.ok(buttons(view).some((b) => b.callback_data === "dl:2" && b.text === "← К черновикам"));
      assert.ok(buttons(view).some((b) => b.callback_data.startsWith(`pub:${ids[0]}:`)));
    });

    it("/last: по умолчанию 3, максимум 10, ссылка для публичного канала", async () => {
      for (let i = 0; i < 12; i++) addPost("sent", `Пост ${i}`, { tg_message_id: 100 + i, sent_at: new Date(Date.now() - (12 - i) * 60e3).toISOString() });
      await say("/last");
      assert.equal(lastSent().text.split("\n\n").length, 3);
      assert.match(lastSent().text, /https:\/\/t\.me\/chan\/111/);
      await say("/last 50");
      assert.equal(lastSent().text.split("\n\n").length, 10);
      ctx.set("channel_id", "-1001234");
      await say("/last 1");
      assert.equal(/t\.me/.test(lastSent().text), false, "у закрытого канала ссылки нет");
      await say("/last abc");
      assert.match(lastSent().text, /Использование/);
    });

    it("/post N: кнопки по статусу; «Удалить из канала» — через подтверждение", async () => {
      const draft = addPost("draft");
      const sentId = addPost("sent", "Опубликованный", { tg_message_id: 42 });
      const skipped = addPost("skipped");
      await say(`/post ${draft}`);
      assert.deepEqual(buttons(lastSent()).map((b) => b.text), ["Опубликовать", "Другой вариант", "Отклонить"]);
      await say(`/post ${skipped}`);
      assert.deepEqual(buttons(lastSent()).map((b) => b.text), ["Написать заново"]);
      await say(`/post ${sentId}`);
      assert.deepEqual(buttons(lastSent()).map((b) => b.text), ["Открыть в канале", "Удалить из канала"]);
      await click(`dc:${sentId}`);
      assert.equal(ctx.post(sentId).status, "sent");
      await click(confirmYes(lastSent()));
      assert.ok(calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 42));
      assert.equal(ctx.post(sentId).status, "rejected");
      await say("/post 999");
      assert.match(lastSent().text, /не найден/);
    });

    it("/note: пояснение сохраняется (до 500 символов), затем кнопка «Написать заново»", async () => {
      const id = addPost("draft", "Т", { notes: JSON.stringify({ post: "", commits: { [sha("a")]: "к коммиту" } }) });
      await say(`/note ${id} Экспорт нужен для отчётов`);
      assert.deepEqual(JSON.parse(ctx.post(id).notes), { post: "Экспорт нужен для отчётов", commits: { [sha("a")]: "к коммиту" } });
      assert.equal(buttons(lastSent())[0].callback_data, `regen:${id}`);
      await say(`/note ${id} ${"x".repeat(501)}`);
      assert.match(lastSent().text, /длиннее 500/);
      await say(`/note ${addPost("sent")} текст`);
      assert.match(lastSent().text, /уже опубликован/);
    });

    it("/regen: активный черновик без номера; подсказка «короче» — переписывание варианта; неизвестная — список", async () => {
      const id = addPost("draft", "x", { input_data: JSON.stringify({ commits: [{ sha: sha("a"), message: "feat: x" }], files: [] }) });
      await poster.generate(id, true, ctx);
      const aiCalls = [];
      ctx.aiCall = fakeAi({ calls: aiCalls });
      await say("/regen короче");
      await waitFor(() => sent().some((m) => /^Черновик #/.test(m.text)));
      assert.deepEqual(aiCalls.map((c) => c.step), ["write", "verify"], "переписывание выбранного варианта, без новых фактов");
      assert.match(aiCalls[0].user, /Пожелание автора к новой версии: Короче/);
      await say(`/regen ${id} громче`);
      assert.match(lastSent().text, /Подсказки: короче, проще, ярче, подробнее/);
      aiCalls.length = 0;
      await say(`/regen ${id}`);
      await waitFor(() => aiCalls.some((c) => c.step === "verify"));
      await poster.waitIdle(1000);
      assert.equal(aiCalls[0].step, "facts", "без подсказки — полный новый вариант");
    });

    it("/tone проще — правка активного черновика; без черновика — понятный ответ", async () => {
      await say("/tone проще");
      assert.match(lastSent().text, /Нет черновика/);
      await say("/tone громко");
      assert.match(lastSent().text, /короче \| ярче \| проще \| подробнее/);
    });

    it("/skip: подтверждение — успех, повтор, отмена, таймаут 60 с", async () => {
      const a = addPost("draft");
      await say(`/skip ${a}`);
      const ask = lastSent();
      assert.match(ask.text, /«не публиковать»[\s\S]*60 секунд/);
      assert.equal(ctx.post(a).status, "draft");
      const yes = confirmYes(ask);
      await click(yes);
      assert.equal(ctx.post(a).status, "rejected");
      assert.match(ctx.post(a).error, /Не публиковать/);
      await click(yes);
      assert.match(answers().at(-1).text, /Уже выполнено или отменено/);

      const b = addPost("draft");
      await say(`/skip ${b}`);
      const noBtn = buttons(lastSent()).find((x) => x.text === "Отмена").callback_data;
      await click(noBtn);
      assert.equal(ctx.post(b).status, "draft");
      await click(confirmYes(lastSent()));
      assert.equal(ctx.post(b).status, "draft", "после отмены подтверждение не работает");

      await say(`/skip ${b}`);
      const late = confirmYes(lastSent());
      ctx.db.prepare("update bot_confirms set expires_at=?").run(Date.now() - 1);
      await click(late);
      assert.equal(ctx.post(b).status, "draft");
      assert.match(edits().at(-1).text, /Время подтверждения \(60 секунд\) истекло/);
    });
  });

  describe("Коммиты", () => {
    it("/commits: отметка «в посте #N», «Сделать пост» создаёт черновик даже в режиме auto", async () => {
      ctx.set("mode", "auto");
      ctx.db.prepare("insert into posts(user_id,id,head,input,status,text) values(1,7,'x','i','sent','t')").run();
      ctx.recordPostCommits(7, [sha("b")]);
      await say("/commits 2");
      const m = lastSent();
      assert.match(m.text, /^Последние коммиты ветки main: 2/);
      assert.match(m.text, /bbbbbbb fix: поиск[\s\S]*в посте #7/);
      assert.deepEqual(buttons(m).map((b) => b.callback_data), [`mk:${sha("a")}`, `mk:${sha("b")}`, "sel"]);
      await click(`mk:${sha("a")}`);
      assert.match(edits().at(-1).text, /^Черновик #\d+ создаётся из 1 коммита/);
      await poster.waitIdle(2000);
      await waitFor(() => sent().some((x) => /^Черновик #\d+/.test(x.text)));
      const post = ctx.db.prepare("select * from posts order by id desc limit 1").get();
      assert.equal(post.status, "draft");
      assert.equal(calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === "@chan").length, 0);
      await say("/commits 99");
      assert.match(lastSent().text, /: 3$/m);
    });

    it("«Выбрать несколько»: галочки редактируют сообщение, «Создать пост» — из отмеченных; повтор — подтверждение дубля", async () => {
      await say("/commits 3");
      await click("sel");
      assert.match(buttons(edits().at(-1))[0].text, /^☐ aaaaaaa/);
      await click("cc");
      assert.match(answers().at(-1).text, /Отметьте хотя бы один/);
      await click("cs:0");
      await click("cs:2");
      await click("cs:2");
      await click("cs:1");
      const sel = edits().at(-1);
      assert.deepEqual(buttons(sel).map((b) => b.text.slice(0, 2)), ["☑ ", "☑ ", "☐ ", "Со", "От"]);
      assert.equal(buttons(sel).find((b) => b.callback_data === "cc").text, "Создать пост (2)");
      await click("cc");
      await poster.waitIdle(2000);
      const post = ctx.db.prepare("select * from posts order by id desc limit 1").get();
      assert.deepEqual(JSON.parse(post.commits).map((c) => c.sha).sort(), [sha("a"), sha("b")]);
      // Те же коммиты ещё раз — сначала вопрос о дубле
      await click(`mk:${sha("a")}`);
      assert.match(lastSent().text, /уже есть в постах[\s\S]*60 секунд/);
      const count = ctx.countPosts();
      await click(confirmYes(lastSent()));
      await poster.waitIdle(2000);
      assert.equal(ctx.countPosts(), count + 1);
    });

    it("/diff: файлы с +/− без diff, шум отфильтрован не нужен — показываются все файлы коммита", async () => {
      await say("/diff aaaaaaa");
      const t = lastSent().text;
      assert.match(t, /^aaaaaaa feat: экспорт в Markdown/);
      assert.match(t, /\+40 −2 {2}src\/export\.js/);
      assert.equal(t.includes("+x"), false, "без содержимого diff");
      await say("/diff zz");
      assert.match(lastSent().text, /Использование/);
      await say("/diff 1234567");
      assert.match(lastSent().text, /Коммит не найден/);
    });

    it("/since: 12h, 2d, 1w и проверка формата", async () => {
      assert.deepEqual(commands.parsePeriod("12h").label, "12 ч");
      assert.deepEqual(commands.parsePeriod("2д").label, "2 дн");
      assert.equal(commands.parsePeriod("1w").ms, 7 * 24 * 3600e3);
      assert.equal(commands.parsePeriod("5y"), null);
      await say("/since 12h");
      assert.match(lastSent().text, /^Коммиты за 12 ч \(ветка main\): 1/);
      await say("/since 2d");
      assert.match(lastSent().text, /: 2/);
      await say("/since 1h");
      assert.match(lastSent().text, /коммитов в ветке main нет/);
      await say("/since вчера");
      assert.match(lastSent().text, /Использование/);
    });

    it("/branches: смена ветки через подтверждение сбрасывает состояние проверки", async () => {
      for (const [k, v] of Object.entries({ last_sha: "abc", pending_head: "def", pending_at: "1" })) ctx.set(k, v);
      await say("/branches");
      const m = lastSent();
      assert.match(m.text, /● main \(защищена\)/);
      assert.deepEqual(buttons(m).map((b) => b.text), ["Отслеживать dev"]);
      await click(buttons(m)[0].callback_data);
      assert.equal(ctx.get("branch"), "main", "до подтверждения не меняется");
      await click(confirmYes(lastSent()));
      assert.equal(ctx.get("branch"), "dev");
      assert.equal(ctx.get("last_sha"), "");
      assert.equal(ctx.get("pending_head"), "");
    });
  });

  describe("Состояние и управление", () => {
    it("/status: репозиторий, режим, интервал, черновики, последний пост, канал, ИИ, GitHub, ошибки за 24 часа", async () => {
      addPost("draft");
      addPost("sent", "т", { sent_at: new Date().toISOString() });
      ctx.logEvent("check", "GitHub вернул 500");
      ctx.getNextPollAt = () => Date.now() + 5 * 60e3;
      await say("/status");
      const t = lastSent().text;
      for (const re of [/Репозиторий: me\/repo, ветка main/, /Режим: черновики/, /Автопроверка: каждые 5 мин, следующая/, /Черновиков ждёт: 1/, /Последний опубликованный: #\d+/, /Канал: подключён \(@chan\)/, /ИИ: anthropic, claude-sonnet-5-5/, /GitHub: подключён \(токен\)/, /Ошибок за 24 часа: 1\n• .*GitHub вернул 500/]) {
        assert.match(t, re);
      }
      assert.equal(t.includes("sk-secret-key"), false);
    });

    it("/pause останавливает автоматическую проверку (флаг в базе), /check работает; /resume возобновляет", async () => {
      ctx.set("last_sha", sha("c"));
      await say("/pause");
      assert.equal(ctx.get("paused"), "1");
      assert.equal((await poster.check(false, ctx, { silent: true })).status, "paused");
      await say("/status");
      assert.match(lastSent().text, /Автопроверка: на паузе/);
      const manual = await poster.check(true, ctx, { silent: true });
      assert.notEqual(manual.status, "paused", "ручная проверка не блокируется");
      await poster.waitIdle(2000);
      await say("/resume");
      assert.equal(ctx.get("paused"), "0");
      assert.notEqual((await poster.check(false, ctx, { silent: true })).status, "paused");
    });

    it("режим «Публиковать сразу» из бота не включается; /mode approve — можно", async () => {
      ctx.set("mode", "digest");
      for (const t of ["/mode auto", "/auto", "/mode AUTO", "/mode digest"]) {
        await say(t);
        assert.match(lastSent().text, /только в панели/);
      }
      assert.equal(ctx.get("mode"), "digest");
      await say("/mode approve");
      assert.equal(ctx.get("mode"), "approve");
    });

    it("/repo список: смена через подтверждение сбрасывает last_sha и debounce", async () => {
      for (const [k, v] of Object.entries({ last_sha: "abc", pending_head: "def", pending_at: "1", last_digest_sha: "z" })) ctx.set(k, v);
      await say("/repo");
      assert.match(lastSent().text, /Репозиторий: me\/repo, ветка main/);
      await say("/repo список");
      const m = lastSent();
      assert.deepEqual(buttons(m).map((b) => b.text), ["● me/repo", "me/other"]);
      await click(buttons(m)[1].callback_data);
      assert.match(lastSent().text, /me\/other \(ветка trunk\)/);
      assert.equal(ctx.get("repo"), "me/repo");
      await click(confirmYes(lastSent()));
      assert.equal(ctx.get("repo"), "me/other");
      assert.equal(ctx.get("branch"), "trunk");
      for (const k of ["last_sha", "pending_head", "pending_at", "last_digest_sha"]) assert.equal(ctx.get(k), "", k);
    });

    it("/stats: посты и вызовы ИИ за 7 и 30 дней, оценка помечена", async () => {
      addPost("sent", "т", { sent_at: new Date().toISOString() });
      addPost("skipped");
      addPost("rejected");
      const old = addPost("sent", "т", { sent_at: "2026-01-01T00:00:00Z" });
      ctx.db.prepare("update posts set created_at='2026-01-01 00:00:00' where id=?").run(old);
      ctx.recordUsage({ step: "facts", model: "m", input: 1000, output: 200 });
      ctx.recordUsage({ step: "write", model: "m", input: 500, output: 100, estimated: true });
      await say("/stats");
      const t = lastSent().text;
      assert.match(t, /За 7 дней:\nсоздано постов: 3, опубликовано: 1, пропущено: 1, отклонено: 1/);
      assert.match(t, /вызовов ИИ: 2, токенов ≈ 1\s?800/);
      assert.match(t, /оценка для 1 из 2 вызовов/);
    });

    it("вызовы ИИ из конвейера учитываются: токены провайдера или оценка", async () => {
      const id = addPost("draft", "x", { input_data: JSON.stringify({ commits: [{ sha: sha("a"), message: "feat: x" }], files: [] }) });
      await poster.generate(id, true, ctx);
      const u = ctx.usageStats(7);
      assert.equal(u.calls, 4);
      assert.equal(u.estimated, 4, "мок не сообщает токены — везде оценка");
    });

    it("/ai: провайдер и модель без ключа; «Проверить» — один короткий запрос, ключ скрыт", async () => {
      await say("/ai");
      assert.match(lastSent().text, /Провайдер: anthropic\nМодель: claude-sonnet-5-5/);
      assert.equal(lastSent().text.includes("sk-secret-key"), false);
      ctx.aiCall = async () => "связь есть, ключ sk-secret-key";
      await click("ai");
      assert.match(edits().at(-1).text, /^ИИ отвечает: [\d.]+ с \(anthropic, claude-sonnet-5-5\): «связь есть, ключ \[СКРЫТО\]»/);
      ctx.aiCall = async () => {
        throw new Error("invalid key sk-secret-key");
      };
      await click("ai");
      assert.match(edits().at(-1).text, /^ИИ не ответил: invalid key \[СКРЫТО\]/);
    });

    it("/test: сообщение владельцу; «Тестовый пост в канал» — только после подтверждения", async () => {
      await say("/test");
      assert.match(lastSent().text, /бот на связи/);
      const toChannel = () => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === "@chan");
      await click("ct");
      assert.equal(toChannel().length, 0);
      await click(confirmYes(lastSent()));
      assert.equal(toChannel().length, 1);
    });

    it("/channel и «Проверить»: права бота из getChatMember", async () => {
      await say("/channel");
      assert.match(lastSent().text, /Канал: @chan/);
      await click("ch");
      assert.match(edits().at(-1).text, /✅ Бот @poster_bot — администратор канала @chan, может публиковать/);
    });

    it("/panel, /whoami, /health, /backup", async () => {
      process.env.PUBLIC_URL = "https://poster.example.org";
      await say("/panel");
      assert.equal(lastSent().text, "Панель: https://poster.example.org");
      delete process.env.PUBLIC_URL;
      ctx.set("tg_owner_bound_at", "2026-10-20T10:00:00Z");
      await say("/whoami");
      assert.match(lastSent().text, /Владелец: @owner \(ID 111\), привязан 20 окт/);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-backup-"));
      ctx.BACKUP_MARKER = path.join(dir, "last-backup.json");
      await say("/backup");
      assert.match(lastSent().text, /Резервных копий ещё не было/);
      fs.writeFileSync(ctx.BACKUP_MARKER, JSON.stringify({ at: new Date().toISOString(), encrypted: true, uploaded: false }));
      await say("/backup");
      assert.match(lastSent().text, /Последняя резервная копия: .*зашифрована/);
      ctx.set("last_ok_check", new Date().toISOString());
      await say("/health");
      for (const re of [/^Версия: /, /Работает: /, /Последняя успешная проверка GitHub: /, /GitHub: в порядке/, /Последняя резервная копия/]) assert.match(lastSent().text, re);
      // Размер базы — сведения о всей платформе, пользователю их не показываем
      assert.doesNotMatch(lastSent().text, /База: /);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("/unbind: подтверждение → владелец отвязан, бот молчит; новая привязка по коду из панели", async () => {
      await say("/unbind");
      assert.equal(ctx.get("tg_owner_chat_id"), String(OWNER));
      await click(confirmYes(lastSent()));
      assert.equal(ctx.get("tg_owner_chat_id"), "");
      assert.ok(calls.some((c) => c.method === "deleteMyCommands"));
      const n = calls.length;
      await say("/status");
      await say("/help");
      assert.equal(calls.length, n, "после отвязки бот молчит");
      const { code } = ctx.platform.createTgLinkCode(ctx.userId, OWNER_CODE_TTL_MS);
      await say(`/start ${code}`);
      assert.equal(ctx.get("tg_owner_chat_id"), String(OWNER));
      assert.ok(ctx.get("tg_owner_bound_at"));
      await say("/status");
      assert.match(lastSent().text, /Репозиторий/);
    });
  });
});
