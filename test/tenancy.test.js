const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const poster = require("../lib/poster");
const { handleUpdate, OWNER_CODE_TTL_MS } = require("../lib/telegram-bot");
const { issueState, consumeState } = require("../lib/github-app");
const { fakeAi } = require("./helpers/fake-ai");
const { rawFetch } = require("./helpers/tenant");

// Публичная платформа: два независимых человека на одном сервере. Все запросы — через rawFetch,
// без автоматической подстановки CSRF из тестового помощника: токен передаётся явно.
// GitHub, Telegram и ИИ подменены, реальных публикаций и платных запросов нет.
const KEY = "tenancy-encryption-key";
const SECRET = "tenancy-session-secret-0123456789abcdef";
const BOT = "424242:platform-bot-token";
const ALICE = { username: "Alice", password: "wonderland-pass-1" };
const BOB = { username: "bob", password: "builder-pass-22" };
const sha = (c) => c.repeat(40);

const quiet = () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return () => Object.assign(console, saved);
};

// GitHub: у каждого свой токен и свой репозиторий. Чужой репозиторий по своему токену — 404
const REPOS = { "alice-gh": "alice/private", "bob-gh": "bob/public" };
const commitOf = (repo, s, msg) => ({ sha: s, commit: { message: msg, author: { name: repo, date: "2026-10-24T09:00:00Z" }, committer: { date: "2026-10-24T09:00:00Z" } }, author: { login: repo.split("/")[0] }, parents: [{ sha: sha("0") }] });
const COMMITS = {
  "alice/private": [commitOf("alice/private", sha("a"), "feat: секретная функция Alice")],
  "bob/public": [commitOf("bob/public", sha("b"), "feat: функция Bob")],
};

function makeEnv(dbPath = ":memory:") {
  const restore = quiet();
  const platform = createDatabase(dbPath, KEY);
  restore();
  const tgCalls = [];
  const ghCalls = [];
  const aiKeys = [];
  const ai = fakeAi({ text: "Новая функция готова" });
  const json = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });
  const base = {
    platform,
    SESSION_SECRET: SECRET,
    ENCRYPTION_KEY: KEY,
    TG_BOT_TOKEN: BOT,
    REGISTRATION_LIMIT_PER_HOUR: 1000,
    tg: async (method, body, token) => {
      tgCalls.push({ method, body, token });
      if (method === "getMe") return { ok: true, result: { id: 9000, username: "platform_bot" } };
      if (method === "getChatMember") return { ok: true, result: { status: "administrator", can_post_messages: true } };
      return { ok: true, result: { message_id: 100 + tgCalls.length } };
    },
    gh: async (p, token) => {
      ghCalls.push({ p, token });
      const repo = REPOS[token];
      const m = p.match(/^\/repos\/([^/]+\/[^/]+)\/(commits|compare)(.*)$/);
      if (!m || m[1] !== repo) return json({ message: "Not Found" }, 404);
      const list = COMMITS[repo];
      if (m[2] === "compare") return json({ status: "ahead", commits: [...list].reverse() });
      const one = m[3].match(/^\/([0-9a-f]{40})$/);
      if (one) {
        const c = list.find((x) => x.sha === one[1]);
        return c ? json({ ...c, files: [{ filename: "src/app.js", status: "modified", additions: 3, deletions: 1, patch: "+x" }] }) : json({ message: "Not Found" }, 404);
      }
      return json(list);
    },
    buildInput: async (r, b, h, msgs) => "Коммиты:\n" + msgs.join("\n"),
    aiCall: (req) => {
      aiKeys.push(req.key);
      return ai(req);
    },
  };
  const userCtx = (id) => ({ ...base, ...platform.forUser(id) });
  return { platform, base, userCtx, tgCalls, ghCalls, aiKeys };
}

async function startServer(base) {
  const server = http.createServer(createApp(base));
  await new Promise((r) => server.listen(0, r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Клиент одного браузера: своя cookie и свой CSRF-токен
function client(url) {
  const c = { cookie: "", csrf: "" };
  const remember = async (res) => {
    const set = res.headers.get("set-cookie");
    if (set) c.cookie = set.split(";")[0];
    const body = await res.json().catch(() => ({}));
    if (body.csrf) c.csrf = body.csrf;
    return { status: res.status, body, setCookie: set };
  };
  c.request = async (method, p, body, { csrf = true, headers = {} } = {}) => {
    const h = { cookie: c.cookie, ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && method !== "GET") h["x-csrf-token"] = c.csrf;
    return remember(await rawFetch(url + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
  };
  c.get = (p, opts) => c.request("GET", p, undefined, opts);
  c.post = (p, body = {}, opts) => c.request("POST", p, body, opts);
  c.register = (creds) => c.request("POST", "/api/auth/register", creds, { csrf: false });
  c.login = (creds) => c.request("POST", "/api/auth/login", creds, { csrf: false });
  return c;
}

const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

describe("Два независимых аккаунта на одной платформе", () => {
  let env;
  let srv;
  let alice;
  let bob;
  let aliceId;
  let bobId;
  let alicePost;

  before(async () => {
    env = makeEnv();
    srv = await startServer(env.base);
    alice = client(srv.url);
    bob = client(srv.url);
  });
  after(() => srv.close());

  it("1–2. Alice и Bob регистрируются по имени и паролю и сразу входят", async () => {
    const a = await alice.register(ALICE);
    assert.equal(a.status, 201);
    assert.equal(a.body.username, "Alice");
    assert.match(a.setCookie, /^sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\//);
    assert.ok(a.body.csrf);
    // В ответе нет ни пароля, ни хеша, ни самого токена сессии
    assert.equal(JSON.stringify(a.body).includes(alice.cookie.slice(4)), false);
    assert.equal(JSON.stringify(a.body).includes("scrypt"), false);

    assert.equal((await bob.register(BOB)).status, 201);
    aliceId = env.platform.userByUsername("alice").id;
    bobId = env.platform.userByUsername("bob").id;
    assert.notEqual(aliceId, bobId);
  });

  it("3–4. сессии независимы, работают одновременно", async () => {
    const [a, b] = await Promise.all([alice.get("/api/auth/me"), bob.get("/api/auth/me")]);
    assert.equal(a.body.username, "Alice");
    assert.equal(b.body.username, "bob");
    assert.notEqual(alice.cookie, bob.cookie);
    // В базе — только хеш токена
    const row = env.platform.db.prepare("select token_hash from sessions where user_id=?").get(aliceId);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.token_hash, alice.cookie.slice(4));
  });

  it("новый аккаунт видит пустую панель и шаги первой настройки", async () => {
    const st = await bob.get("/api/state");
    assert.equal(st.status, 200);
    assert.equal(st.body.user.username, "bob");
    assert.deepEqual(st.body.posts, []);
    assert.equal(st.body.counts.all, 0);
    assert.equal(st.body.settings.repo, "");
    assert.equal(st.body.settings.ai_key_set, false);
  });

  it("8–9. GitHub и ИИ у каждого свои; ключ Alice Bob не видит и не использует", async () => {
    assert.equal((await alice.post("/api/settings", { repo: "alice/private", github_token: "alice-gh", ai_key: "sk-alice-key", ai_model: "m", ai_provider: "anthropic" })).status, 200);
    assert.equal((await bob.post("/api/settings", { repo: "bob/public", github_token: "bob-gh", ai_key: "sk-bob-key", ai_model: "m", ai_provider: "anthropic" })).status, 200);

    const sa = await alice.get("/api/state");
    const sb = await bob.get("/api/state");
    assert.equal(sa.body.settings.repo, "alice/private");
    assert.equal(sb.body.settings.repo, "bob/public");
    assert.equal(sa.body.settings.ai_key_set, true);
    for (const s of [sa, sb]) {
      const text = JSON.stringify(s.body);
      for (const secret of ["sk-alice-key", "sk-bob-key", "alice-gh", "bob-gh"]) assert.equal(text.includes(secret), false, secret);
    }
    // Секреты в базе зашифрованы
    const raw = env.platform.db.prepare("select v from user_settings where user_id=? and k='ai_key'").get(aliceId).v;
    assert.match(raw, /^enc:v1:/);
  });

  it("5. Alice создаёт пост из своих коммитов — её ключом ИИ и её токеном GitHub", async () => {
    env.aiKeys.length = 0;
    env.ghCalls.length = 0;
    const r = await alice.post("/api/posts/from-commits", { shas: [sha("a")] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    alicePost = r.body.id;
    assert.ok(await waitFor(() => env.userCtx(aliceId).post(alicePost)?.status === "draft"));
    assert.ok(env.aiKeys.length > 0);
    assert.ok(env.aiKeys.every((k) => k === "sk-alice-key"), "только ключ Alice");
    assert.ok(env.ghCalls.every((c) => c.token === "alice-gh"), "только токен Alice");
  });

  it("6. Bob не видит пост Alice ни в списке, ни в счётчиках", async () => {
    const sb = await bob.get("/api/state?limit=100");
    assert.deepEqual(sb.body.posts, []);
    assert.equal(sb.body.counts.all, 0);
    const sa = await alice.get("/api/state?limit=100");
    assert.deepEqual(sa.body.posts.map((p) => p.id), [alicePost]);
  });

  it("7. Bob не может прочитать, изменить, удалить или опубликовать пост Alice по его id", async () => {
    env.tgCalls.length = 0;
    const before = env.userCtx(aliceId).post(alicePost);
    const attempts = [
      ["POST", `/api/posts/${alicePost}/publish`, { text: "взлом", confirm_unverified: true }],
      ["POST", `/api/posts/${alicePost}/text`, { text: "взлом" }],
      ["POST", `/api/posts/${alicePost}/notes`, { post: "взлом" }],
      ["POST", `/api/posts/${alicePost}/regen`, {}],
      ["POST", `/api/posts/${alicePost}/variant`, { angle: "a1" }],
      ["POST", `/api/posts/${alicePost}/rewrite`, { hint: "shorter" }],
      ["POST", `/api/posts/${alicePost}/reject`, {}],
      ["POST", `/api/posts/${alicePost}/delete-from-channel`, {}],
      ["POST", `/api/posts/${alicePost}/delete`, {}],
      ["DELETE", `/api/posts/${alicePost}`, undefined],
    ];
    for (const [method, p, body] of attempts) {
      const r = await bob.request(method, p, body);
      assert.ok([404, 409].includes(r.status) || (p.endsWith("/reject") && r.status === 200), `${method} ${p}: ${r.status}`);
      if (r.status === 409) assert.notEqual(r.body.code, undefined);
    }
    const after = env.userCtx(aliceId).post(alicePost);
    assert.deepEqual(after, before, "пост Alice не изменился");
    assert.equal(env.tgCalls.filter((c) => c.method === "sendMessage").length, 0, "в Telegram ничего не ушло");
    // Пояснения к чужому посту через «notes» тоже не сохранились
    assert.equal(env.userCtx(bobId).post(alicePost), undefined);
  });

  it("кэш коммитов не отдаёт приватный репозиторий Alice аккаунту Bob", async () => {
    const a = await alice.get("/api/commits");
    assert.equal(a.status, 200);
    assert.equal(a.body.commits[0].sha, sha("a"));
    // Bob вписывает тот же репозиторий, но его токен к нему доступа не даёт
    assert.equal((await bob.post("/api/settings", { repo: "alice/private" })).status, 200);
    const b = await bob.get("/api/commits");
    assert.equal(b.status, 404);
    assert.equal(JSON.stringify(b.body).includes("секретная"), false);
    await bob.post("/api/settings", { repo: "bob/public" });
  });

  it("журнал событий, статистика и подтверждения бота у каждого свои", () => {
    const a = env.userCtx(aliceId);
    const b = env.userCtx(bobId);
    a.logEvent("check", "ошибка Alice");
    a.recordUsage({ step: "write", model: "m", input: 10, output: 5 });
    const nonce = a.createConfirm("reject", { id: alicePost });
    assert.equal(b.recentEvents().some((e) => e.message === "ошибка Alice"), false);
    assert.ok(a.recentEvents().some((e) => e.message === "ошибка Alice"));
    assert.equal(b.takeConfirm(nonce), null, "чужое подтверждение не срабатывает");
    assert.equal(a.takeConfirm(nonce).action, "reject");
    assert.ok(b.usageStats(1).calls < a.usageStats(1).calls);
  });

  it("10. выход Alice не затрагивает Bob", async () => {
    const aliceCookie = alice.cookie;
    assert.equal((await alice.post("/api/auth/logout")).status, 200);
    assert.equal((await rawFetch(srv.url + "/api/state", { headers: { cookie: aliceCookie } })).status, 401, "сессия Alice отозвана на сервере");
    assert.equal((await bob.get("/api/state")).status, 200);
    // Alice входит снова
    assert.equal((await alice.login(ALICE)).status, 200);
  });

  it("13. повторная регистрация занятого имени — 409 без учёта регистра", async () => {
    const c = client(srv.url);
    const r = await c.register({ username: "ALICE", password: "another-pass-12345" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "USERNAME_TAKEN");
    assert.equal(r.setCookie, null, "сессия не создана");
    assert.equal(env.platform.countUsers(), 2);
  });

  it("14. неверный пароль и несуществующее имя — 401 без сессии и с одинаковым текстом", async () => {
    const c = client(srv.url);
    const wrong = await c.login({ username: "alice", password: "wrong-password-0" });
    const missing = await c.login({ username: "nobody", password: "wrong-password-0" });
    for (const r of [wrong, missing]) {
      assert.equal(r.status, 401);
      assert.equal(r.setCookie, null);
      assert.equal(r.body.error, "Неверное имя или пароль");
    }
  });

  it("15. CSRF: без токена, с чужим токеном и с чужого сайта — отказ", async () => {
    const noToken = await alice.post("/api/settings", { tone: "x" }, { csrf: false });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.code, "CSRF_FAILED");
    const foreignToken = await alice.post("/api/settings", { tone: "x" }, { csrf: false, headers: { "x-csrf-token": bob.csrf } });
    assert.equal(foreignToken.status, 403);
    const foreignSite = await alice.post("/api/settings", { tone: "x" }, { headers: { origin: "https://evil.example" } });
    assert.equal(foreignSite.status, 403);
    // Вход только JSON: HTML-форма с чужого сайта так не отправит (login CSRF)
    const form = await rawFetch(srv.url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=alice&password=x" });
    assert.equal(form.status, 415);
    assert.equal(env.userCtx(aliceId).get("tone"), "");
  });

  it("session fixation: подброшенная cookie после входа больше не действует", async () => {
    const attacker = client(srv.url);
    await attacker.login(BOB);
    const planted = attacker.cookie;
    const victim = client(srv.url);
    victim.cookie = planted; // браузер жертвы пришёл с чужой cookie
    const r = await victim.login(ALICE);
    assert.equal(r.status, 200);
    assert.notEqual(victim.cookie, planted, "после входа — новый токен");
    assert.equal((await rawFetch(srv.url + "/api/auth/me", { headers: { cookie: planted } })).status, 401, "подброшенная сессия отозвана");
    assert.equal((await victim.get("/api/auth/me")).body.username, "Alice");
  });

  it("12. истёкшая сессия не даёт доступа", async () => {
    const c = client(srv.url);
    await c.login(BOB);
    env.platform.db.prepare("update sessions set expires_at=? where token_hash=(select token_hash from sessions order by id desc limit 1)").run(Date.now() - 1000);
    assert.equal((await c.get("/api/state")).status, 401);
  });

  it("смена пароля отзывает свои старые сессии, но не чужие", async () => {
    const second = client(srv.url);
    await second.login(BOB);
    const r = await bob.post("/api/auth/change-password", { current_password: BOB.password, new_password: "fresh-builder-333" });
    assert.equal(r.status, 200);
    assert.equal((await second.get("/api/state")).status, 401, "другая сессия Bob завершена");
    assert.equal((await bob.get("/api/state")).status, 200, "текущий браузер Bob получил новую сессию");
    assert.equal((await alice.get("/api/state")).status, 200, "Alice не затронута");
    BOB.password = "fresh-builder-333";
  });

  it("user_id из тела, query и заголовков игнорируется", async () => {
    const r = await bob.post("/api/settings", { tone: "мой тон", user_id: aliceId }, { headers: { "x-user-id": String(aliceId) } });
    assert.equal(r.status, 200);
    assert.equal(env.userCtx(bobId).get("tone"), "мой тон");
    assert.equal(env.userCtx(aliceId).get("tone"), "");
    const st = await bob.get(`/api/state?user_id=${aliceId}&limit=100`);
    assert.deepEqual(st.body.posts, []);
  });
});

describe("Telegram: один бот, разные аккаунты", () => {
  let env;
  let a;
  let b;

  beforeEach(() => {
    env = makeEnv();
    const restore = quiet();
    const ida = env.platform.createUser("alice", "scrypt$x");
    const idb = env.platform.createUser("bob", "scrypt$x");
    restore();
    a = env.userCtx(ida);
    b = env.userCtx(idb);
  });

  const msg = (from, text) => ({ message: { chat: { id: from, type: "private" }, from: { id: from, username: "u" + from }, text } });
  const run = (u) => handleUpdate(u, env.base, BOT);

  it("привязка по коду: код Alice привязывает чат к Alice; чат Bob не переходит к Alice без отвязки", async () => {
    const { code } = env.platform.createTgLinkCode(a.userId, OWNER_CODE_TTL_MS);
    await run(msg(111, `/start ${code}`));
    assert.equal(a.get("tg_owner_chat_id"), "111");

    const { code: c2 } = env.platform.createTgLinkCode(b.userId, OWNER_CODE_TTL_MS);
    await run(msg(222, `/start ${c2}`));
    assert.equal(b.get("tg_owner_chat_id"), "222");

    // Чат Bob пробует привязаться к Alice новым кодом Alice — отказ
    const { code: c3 } = env.platform.createTgLinkCode(a.userId, OWNER_CODE_TTL_MS);
    env.tgCalls.length = 0;
    await run(msg(222, `/start ${c3}`));
    assert.equal(a.get("tg_owner_chat_id"), "111");
    assert.equal(b.get("tg_owner_chat_id"), "222");
    assert.match(env.tgCalls.at(-1).body.text, /уже привязан к другому аккаунту/);

    // Два аккаунта не могут иметь один чат даже в обход бота: это гарантирует уникальный индекс
    assert.throws(() => b.set("tg_owner_chat_id", "111"), /UNIQUE/);
  });

  it("команды и кнопки идут в данные своего аккаунта; кнопка с чужим постом ничего не делает", async () => {
    a.set("tg_owner_chat_id", "111");
    b.set("tg_owner_chat_id", "222");
    a.set("channel_id", "-100111");
    b.set("channel_id", "-100222");
    const alicePost = Number(a.db.prepare("insert into posts(user_id,head,input,text,status) values(?,'h','i','Пост Alice','draft')").run(a.userId).lastInsertRowid);

    env.tgCalls.length = 0;
    await run({ callback_query: { id: "x", from: { id: 222 }, data: `pub:${alicePost}`, message: { message_id: 1, chat: { id: 222 }, text: "" } } });
    assert.equal(a.post(alicePost).status, "draft", "Bob не опубликовал пост Alice");
    assert.equal(env.tgCalls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("-100")).length, 0);

    await run(msg(222, "/drafts"));
    assert.doesNotMatch(env.tgCalls.filter((c) => c.body?.chat_id === "222").map((c) => c.body.text).join("\n"), /Пост Alice/);

    await run({ callback_query: { id: "y", from: { id: 111 }, data: `pub:${alicePost}`, message: { message_id: 1, chat: { id: 111 }, text: "" } } });
    assert.equal(a.post(alicePost).status, "sent");
    const sent = env.tgCalls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("-100"));
    assert.deepEqual(sent.map((c) => c.body.chat_id), ["-100111"], "в канал Alice, не Bob");
    assert.equal(sent[0].token, BOT, "токен бота — платформы, пользователям не передаётся");
  });

  it("канал: чужой канал не подключить; один канал — один аккаунт", async () => {
    a.set("tg_owner_chat_id", "111");
    b.set("tg_owner_chat_id", "222");
    const { linkChannel } = require("../lib/telegram-bot");
    const admins = { 111: "creator", 222: "member" };
    const tg = async (method, body) => {
      if (method === "getChat") return { ok: true, result: { id: -100555, type: "channel", title: "Канал Alice", username: "alice_ch" } };
      if (method === "getChatMember") return { ok: true, result: { status: admins[body.user_id] || "left" } };
      return { ok: true, result: {} };
    };
    const rb = await linkChannel({ ...b, tg }, "@alice_ch");
    assert.equal(rb.status, 403, "Bob не администратор канала Alice");
    assert.equal(b.get("channel_id"), "");
    assert.equal((await linkChannel({ ...a, tg }, "@alice_ch")).ok, true);
    assert.equal(a.get("channel_id"), "-100555");

    admins[222] = "administrator"; // даже став админом, Bob не заберёт уже подключённый канал
    const again = await linkChannel({ ...b, tg }, "@alice_ch");
    assert.equal(again.status, 409);
    assert.equal(again.code, "TELEGRAM_CHANNEL_TAKEN");

    // Бота добавил в канал Bob, но канал уже у Alice — к Bob он не подключается
    await run({ my_chat_member: { chat: { id: -100555, type: "channel" }, from: { id: 222 }, new_chat_member: { status: "administrator" } } });
    assert.equal(b.get("channel_id"), "");
  });
});

describe("Фоновые задачи и GitHub для нескольких аккаунтов", () => {
  it("17. фоновая проверка в режиме auto публикует каждому в свой канал своим ключом", async () => {
    const env = makeEnv();
    const restore = quiet();
    const ida = env.platform.createUser("alice", "scrypt$x");
    const idb = env.platform.createUser("bob", "scrypt$x");
    restore();
    const settings = (owner, repo, token, channel) => ({
      repo, github_token: token, channel_id: channel, tg_owner_chat_id: owner === "alice" ? "111" : "222", ai_key: `sk-${owner}`, ai_model: "m", mode: "auto", debounce: "0", last_sha: sha("0"),
    });
    for (const [id, s] of [[ida, settings("alice", "alice/private", "alice-gh", "-100111")], [idb, settings("bob", "bob/public", "bob-gh", "-100222")]]) {
      const c = env.userCtx(id);
      for (const [k, v] of Object.entries(s)) c.set(k, v);
    }
    // Обе проверки одновременно: флаг «проверка идёт» у каждого свой
    const [ra, rb] = await Promise.all([poster.check(false, env.userCtx(ida)), poster.check(false, env.userCtx(idb))]);
    assert.equal(ra.status, "created");
    assert.equal(rb.status, "created");
    const a = env.userCtx(ida).getPosts();
    const b = env.userCtx(idb).getPosts();
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].status, "sent");
    assert.equal(b[0].status, "sent");
    assert.match(a[0].commits, /a{40}/);
    assert.match(b[0].commits, /b{40}/);
    const sent = env.tgCalls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("-100"));
    assert.deepEqual(sent.map((c) => c.body.chat_id).sort(), ["-100111", "-100222"]);
    assert.ok(env.aiKeys.includes("sk-alice") && env.aiKeys.includes("sk-bob"));
    // Состояние проверки у каждого своё
    assert.equal(env.userCtx(ida).get("last_sha"), sha("a"));
    assert.equal(env.userCtx(idb).get("last_sha"), sha("b"));
  });

  it("ошибка GitHub у одного аккаунта не влияет на другого", async () => {
    const env = makeEnv();
    const restore = quiet();
    const ida = env.platform.createUser("alice", "scrypt$x");
    const idb = env.platform.createUser("bob", "scrypt$x");
    restore();
    env.userCtx(ida).set("repo", "alice/private");
    env.userCtx(ida).set("github_token", "revoked");
    env.userCtx(idb).set("repo", "bob/public");
    env.userCtx(idb).set("github_token", "bob-gh");
    const ra = await poster.check(false, env.userCtx(ida), { silent: true });
    const rb = await poster.check(false, env.userCtx(idb), { silent: true });
    assert.equal(ra.status, "error");
    assert.equal(rb.status, "first_run");
    assert.equal(env.userCtx(idb).get("last_error"), "");
    assert.match(env.userCtx(ida).get("last_error"), /404/);
  });

  it("GitHub state привязан к сессии: state Alice не подходит к сессии Bob; установку нельзя прикрепить к двум аккаунтам", () => {
    const env = makeEnv();
    const restore = quiet();
    const a = env.userCtx(env.platform.createUser("alice", "scrypt$x"));
    const b = env.userCtx(env.platform.createUser("bob", "scrypt$x"));
    restore();
    const state = issueState(a, SECRET, { purpose: "install", session: "alice-session-token" });
    assert.equal(consumeState(b, SECRET, state, { purpose: "install", session: "bob-session-token" }).ok, false);
    assert.equal(consumeState(a, SECRET, state, { purpose: "install", session: "bob-session-token" }).ok, false, "чужая сессия");
    a.set("github_installation_id", "12345");
    assert.throws(() => b.set("github_installation_id", "12345"), /UNIQUE/);
  });

  it("общий GitHub App из окружения пользователям недоступен", () => {
    const { appCredentials } = require("../lib/github-app");
    const saved = process.env.GITHUB_APP_ID;
    process.env.GITHUB_APP_ID = "999";
    try {
      const env = makeEnv();
      const restore = quiet();
      const a = env.userCtx(env.platform.createUser("alice", "scrypt$x"));
      restore();
      assert.equal(appCredentials(a).appId, null);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_APP_ID;
      else process.env.GITHUB_APP_ID = saved;
    }
  });

  it("без сессии данные аккаунта в обработчиках недоступны (ошибка, а не чужие данные)", async () => {
    const env = makeEnv();
    const { createApp: make } = require("../lib/app");
    const app = make(env.base);
    // Проверка через прокси: любое обращение к данным аккаунта вне запроса с сессией — ошибка
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, r));
    const r = await rawFetch(`http://127.0.0.1:${srv.address().port}/api/state`);
    assert.equal(r.status, 401);
    await new Promise((res) => srv.close(res));
  });
});

describe("Регистрация: проверки и ограничения", () => {
  let env;
  let srv;
  before(async () => {
    env = makeEnv();
    env.base.REGISTRATION_LIMIT_PER_HOUR = 100;
    srv = await startServer(env.base);
  });
  after(() => srv.close());

  it("имя и пароль проверяются; служебные имена заняты", async () => {
    const c = client(srv.url);
    for (const [body, code] of [
      [{ username: "ab", password: "long-enough-pass-1" }, "INVALID_USERNAME"],
      [{ username: "<script>", password: "long-enough-pass-1" }, "INVALID_USERNAME"],
      [{ username: "admin", password: "long-enough-pass-1" }, "INVALID_USERNAME"],
      [{ username: "carol", password: "short" }, "WEAK_PASSWORD"],
      [{ username: "carol", password: "1234567890" }, "WEAK_PASSWORD"],
      [{ username: "carol", password: "carol-carol-1" }, "WEAK_PASSWORD"],
      [{ username: "carol", password: "x".repeat(200) }, "WEAK_PASSWORD"],
    ]) {
      const r = await c.register(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, code);
    }
    assert.equal(env.platform.countUsers(), 0);
  });

  it("массовая регистрация с одного адреса упирается в лимит (3 в час по умолчанию)", async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await client(srv.url).register({ username: `user${i}`, password: "long-enough-pass-1" })).status);
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  });

  it("суточный лимит регистраций с адреса действует отдельно от часового", async () => {
    const e = makeEnv();
    Object.assign(e.base, { REGISTRATION_PER_IP_PER_HOUR: 100, REGISTRATION_PER_IP_PER_DAY: 2 });
    const s = await startServer(e.base);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await client(s.url).register({ username: `day${i}`, password: "long-enough-pass-1" })).status);
    assert.deepEqual(statuses, [201, 201, 429]);
    await s.close();
  });

  it("перебор пароля упирается в лимит", async () => {
    const c = client(srv.url);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.login({ username: "user0", password: "wrong-pass-" + i })).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    assert.equal((await c.login({ username: "user0", password: "long-enough-pass-1" })).status, 429, "даже верный пароль — после лимита");
  });

  it("REGISTRATION_OPEN=0 закрывает регистрацию", async () => {
    const e = makeEnv();
    e.base.REGISTRATION_OPEN = false;
    const s = await startServer(e.base);
    const r = await client(s.url).register({ username: "dave", password: "long-enough-pass-1" });
    assert.equal(r.status, 403);
    await s.close();
  });
});

describe("Перезапуск и перенос данных прежней версии", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-tenancy-"));
  });

  it("11. после перезапуска (новый процесс, та же база) сессия продолжает работать", async () => {
    const file = path.join(dir, "app.db");
    const env1 = makeEnv(file);
    const s1 = await startServer(env1.base);
    const c = client(s1.url);
    await c.register(ALICE);
    await s1.close();
    env1.platform.db.close();

    const env2 = makeEnv(file);
    const s2 = await startServer(env2.base);
    const r = await rawFetch(s2.url + "/api/auth/me", { headers: { cookie: c.cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).username, "Alice");
    await s2.close();
    env2.platform.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("16. старые данные без владельца не видит никто, их забирает только CLI; повторно — без изменений", async () => {
    const file = path.join(dir, "app.db");
    // База прежней версии: kv и посты без user_id
    const restore = quiet();
    const legacy = createDatabase(file, KEY);
    legacy.platformSet("repo", "owner/legacy");
    legacy.platformSet("ai_key", "sk-legacy-owner");
    legacy.platformSet("tg_owner_chat_id", "777");
    legacy.db.prepare("insert into posts(head,input,text,status) values('h','i','Старый пост владельца','sent')").run();
    legacy.db.close();
    restore();

    // Первый зарегистрировавшийся на сайте старых данных не получает
    const env = makeEnv(file);
    const s = await startServer(env.base);
    const stranger = client(s.url);
    await stranger.register({ username: "first-visitor", password: "visitor-pass-123" });
    const st = await stranger.get("/api/state?limit=100");
    assert.deepEqual(st.body.posts, []);
    assert.equal(st.body.settings.repo, "");
    assert.equal(st.body.settings.ai_key_set, false);
    await s.close();
    env.platform.db.close();

    const run = (args, extra = {}) =>
      execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "claim-legacy.js"), ...args], {
        env: { ...process.env, DB_PATH: file, ENCRYPTION_KEY: KEY, LEGACY_OWNER_PASSWORD: "owner-secret-pass-9", ...extra },
        encoding: "utf8",
      });
    assert.match(run(["--username", "realowner", "--dry-run"]), /постов без владельца 1/);
    const out = run(["--username", "realowner"]);
    assert.match(out, /Аккаунт realowner создан/);
    assert.match(out, /постов 1/);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("app.db.before-claim-")), "копия базы перед переносом");
    assert.match(run(["--username", "realowner"]), /постов 0, .*настроек 0/, "повторный запуск ничего не меняет");
    assert.throws(() => run(["--username", "first-visitor"], { LEGACY_OWNER_PASSWORD: "visitor-pass-123" }), /уже переданы аккаунту/);

    const p = createDatabase(file, KEY);
    const owner = p.forUser(p.userByUsername("realowner").id);
    assert.equal(owner.get("repo"), "owner/legacy");
    assert.equal(owner.get("ai_key"), "sk-legacy-owner", "ключ расшифровывается тем же ENCRYPTION_KEY");
    assert.equal(owner.get("tg_owner_chat_id"), "777");
    assert.equal(owner.getPosts()[0].text, "Старый пост владельца");
    assert.equal(p.forUser(p.userByUsername("first-visitor").id).getPosts().length, 0);
    p.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Каждый SQL-запрос к данным аккаунта ограничен владельцем", () => {
  // Статическая проверка: в модулях с бизнес-логикой строки SQL с таблицами аккаунта должны упоминать user_id.
  // Так новый запрос без владельца не пройдёт тесты незамеченным
  const TABLES = /\b(posts|announced_items|events|ai_usage|bot_confirms|user_settings)\b/;
  // Строка в кавычках одного вида; внутри могут быть кавычки другого вида (status='draft')
  const STRINGS = [/"((?:[^"\\\n]|\\.)*)"/g, /'((?:[^'\\\n]|\\.)*)'/g, /`((?:[^`\\]|\\.)*)`/g];
  const sqlStrings = (src) => {
    const out = [];
    for (const re of STRINGS) {
      for (const m of src.matchAll(re)) {
        if (/^\s*(select|insert|update|delete)\b/i.test(m[1]) && TABLES.test(m[1])) out.push({ q: m[1], before: src.slice(Math.max(0, m.index - 12), m.index) });
      }
    }
    return out;
  };
  it("проверка сама находит запросы с кавычками внутри", () => {
    const found = sqlStrings(`x.prepare("update posts set status='sent' where id=?")`);
    assert.equal(found.length, 1);
  });
  for (const file of ["app.js", "poster.js", "bot-commands.js", "commits.js", "telegram-bot.js", "notify.js", "pipeline.js", "story.js"]) {
    it(file, () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8");
      for (const { q, before } of sqlStrings(src)) {
        // Фрагмент «update posts set …» без where — только для finish(): условие id и user_id дописывает finish
        if (/^\s*update\b/i.test(q) && !/\bwhere\b/i.test(q) && /finish\($/.test(before)) continue;
        assert.match(q, /user_id/, `${file}: ${q}`);
      }
    });
  }
});
