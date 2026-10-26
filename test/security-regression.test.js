const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const poster = require("../lib/poster");
const { handleUpdate, linkChannel } = require("../lib/telegram-bot");
const { issueState, clearInstallationTokenCache } = require("../lib/github-app");
const { fakeAi } = require("./helpers/fake-ai");
const { rawFetch } = require("./helpers/tenant");

// Регрессия безопасности публичной платформы. Telegram, GitHub и ИИ подменены.
const KEY = "security-regression-key";
const SECRET = "security-regression-secret-0123456789abcdef";
const BOT = "777:platform-bot";

const quiet = () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return () => Object.assign(console, saved);
};

// Telegram: права пользователей в каналах задаёт тест (rights[chat][user] = статус)
function makeEnv(extra = {}) {
  const restore = quiet();
  const platform = createDatabase(":memory:", KEY);
  restore();
  const tgCalls = [];
  const rights = {};
  const base = {
    platform,
    SESSION_SECRET: SECRET,
    ENCRYPTION_KEY: KEY,
    TG_BOT_TOKEN: BOT,
    REGISTRATION_LIMIT_PER_HOUR: 1000,
    tg: async (method, body, token) => {
      tgCalls.push({ method, body, token });
      if (method === "getChatMember") {
        const st = rights[String(body.chat_id)]?.[String(body.user_id)];
        return st ? { ok: true, result: { status: st, can_post_messages: true } } : { ok: false, description: "Bad Request: user not found" };
      }
      if (method === "getChat") return { ok: true, result: { id: Number(body.chat_id) || -100999, type: "channel", title: "Канал" } };
      if (method === "getMe") return { ok: true, result: { id: 1, username: "platform_bot" } };
      return { ok: true, result: { message_id: 100 + tgCalls.length } };
    },
    aiCall: fakeAi({ text: "Готовый пост" }),
    ...extra,
  };
  const user = (name) => {
    const r = quiet();
    const id = platform.createUser(name, "scrypt$x");
    r();
    return { ...base, ...platform.forUser(id) };
  };
  const sends = () => tgCalls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("-100"));
  return { platform, base, rights, tgCalls, user, sends };
}
const addDraft = (c, text = "Пост") => Number(c.db.prepare("insert into posts(user_id,head,input,text,status) values(?,'h','i',?,'draft')").run(c.userId, text).lastInsertRowid);

async function server(base) {
  const s = http.createServer(createApp(base));
  await new Promise((r) => s.listen(0, r));
  const url = `http://127.0.0.1:${s.address().port}`;
  return { url, close: () => new Promise((r) => s.close(r)) };
}
// Вход в аккаунт по API: cookie и CSRF-токен
async function session(url, platform, username, password = "long-enough-pass-1") {
  const { hash } = require("../lib/auth");
  const u = platform.userByUsername(username);
  platform.setPasswordHash(u.id, await hash(password));
  const res = await rawFetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const call = (method, p, data) =>
    rawFetch(url + p, { method, headers: { cookie, "content-type": "application/json", "x-csrf-token": body.csrf }, body: data === undefined ? undefined : JSON.stringify(data) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { cookie, token: cookie.slice(4), post: (p, d = {}) => call("POST", p, d), get: (p) => call("GET", p) };
}

describe("Telegram: права проверяются перед каждой операцией в канале", () => {
  let env;
  let alice;
  beforeEach(() => {
    env = makeEnv();
    alice = env.user("alice");
    alice.set("tg_owner_chat_id", "111");
    alice.set("channel_id", "-100555");
    env.rights["-100555"] = { 111: "administrator" };
  });

  it("публикация после снятия с администраторов — 403, пост остаётся черновиком, в канал ничего", async () => {
    const id = addDraft(alice);
    env.rights["-100555"][111] = "left";
    await assert.rejects(() => poster.publish(id, null, alice), (e) => e.status === 403 && e.code === "TELEGRAM_CHANNEL_ACCESS_REVOKED");
    assert.equal(alice.post(id).status, "draft");
    assert.equal(alice.post(id).interrupted, 0);
    assert.equal(env.sends().length, 0);
    // Права вернули — публикация проходит
    env.rights["-100555"][111] = "creator";
    await poster.publish(id, null, alice);
    assert.equal(alice.post(id).status, "sent");
  });

  it("администратор без права публикации тоже не публикует", async () => {
    const id = addDraft(alice);
    env.base.tg = async (method, body, token) =>
      method === "getChatMember" ? { ok: true, result: { status: "administrator", can_post_messages: false } } : { ok: true, result: { message_id: 1 } };
    const ctx = { ...alice, tg: env.base.tg };
    await assert.rejects(() => poster.publish(id, null, ctx), (e) => e.code === "TELEGRAM_CHANNEL_ACCESS_REVOKED");
  });

  it("без привязанного Telegram публиковать нельзя (нечем проверить права)", async () => {
    alice.set("tg_owner_chat_id", "");
    const id = addDraft(alice);
    await assert.rejects(() => poster.publish(id, null, alice), (e) => e.status === 409 && e.code === "TELEGRAM_NOT_LINKED");
    assert.equal(env.sends().length, 0);
  });

  it("кнопка «Опубликовать» в боте после отзыва прав ничего не публикует", async () => {
    const id = addDraft(alice);
    env.rights["-100555"][111] = "member";
    await handleUpdate({ callback_query: { id: "c", from: { id: 111 }, data: `pub:${id}`, message: { message_id: 1, chat: { id: 111 }, text: "" } } }, env.base, BOT);
    assert.equal(alice.post(id).status, "draft");
    assert.equal(env.sends().length, 0);
  });

  it("режим auto после отзыва прав: пост не уходит в канал", async () => {
    for (const [k, v] of Object.entries({ repo: "a/b", github_token: "t", ai_key: "k", ai_model: "m", mode: "auto", debounce: "0", last_sha: "0".repeat(40) })) alice.set(k, v);
    const c = { ...alice, gh: async () => ({ ok: true, status: 200, json: async () => [{ sha: "a".repeat(40), commit: { message: "feat: x" }, parents: [{}] }, { sha: "0".repeat(40), commit: { message: "base" }, parents: [] }] }), buildInput: async () => "Коммиты:\nfeat: x" };
    env.rights["-100555"][111] = "left";
    await poster.check(false, c, { silent: true });
    assert.equal(env.sends().length, 0);
    assert.equal(alice.getPosts()[0].status, "draft", "черновик ждёт, пока вернут права");
  });

  it("тестовый пост и удаление из канала через панель после отзыва прав — 403", async () => {
    const s = await server(env.base);
    try {
      const sess = await session(s.url, env.platform, "alice");
      const sent = Number(alice.db.prepare("insert into posts(user_id,head,input,text,status,tg_message_id) values(?,'h','i','t','sent',42)").run(alice.userId).lastInsertRowid);
      env.rights["-100555"][111] = "left";
      const t = await sess.post("/api/test/channel-post");
      assert.equal(t.status, 403);
      assert.equal(t.body.code, "TELEGRAM_CHANNEL_ACCESS_REVOKED");
      const d = await sess.post(`/api/posts/${sent}/delete-from-channel`);
      assert.equal(d.status, 403);
      assert.equal(env.tgCalls.filter((x) => x.method === "deleteMessage" || (x.method === "sendMessage" && String(x.body.chat_id).startsWith("-100"))).length, 0);
      assert.equal(alice.post(sent).status, "sent");
    } finally {
      await s.close();
    }
  });

  it("канал, занятый аккаунтом без прав, переходит к настоящему администратору; с правами — нет", async () => {
    const carol = env.user("carol");
    carol.set("tg_owner_chat_id", "333");
    env.rights["-100555"][333] = "creator";
    // Alice ещё администратор — канал не отдаётся
    const busy = await linkChannel(carol, "-100555");
    assert.equal(busy.status, 409);
    assert.equal(alice.get("channel_id"), "-100555");
    // Alice сняли — канал переходит к Carol, у Alice в журнале запись
    env.rights["-100555"][111] = "left";
    const r = await linkChannel(carol, "-100555");
    assert.equal(r.ok, true);
    assert.equal(carol.get("channel_id"), "-100555");
    assert.equal(alice.get("channel_id"), "");
    assert.ok(alice.recentEvents().some((e) => /Канал отключён/.test(e.message)));
  });
});

describe("GitHub App: установка привязана к приложению своего аккаунта", () => {
  let env;
  let s;
  let saved;
  const { privateKey: alicePem } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const { privateKey: bobPem } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

  before(async () => {
    env = makeEnv();
    s = await server(env.base);
    saved = global.fetch;
    // GitHub: установка 555 принадлежит приложению 111 (Alice). JWT — от приложения, указанного в iss
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith("https://api.github.com/")) return saved(url, opts);
      const jwt = String(opts.headers?.Authorization || "").replace("Bearer ", "");
      const iss = JSON.parse(Buffer.from(jwt.split(".")[1] || "", "base64url").toString() || "{}").iss;
      if (u.endsWith("/app/installations/555") && iss === "111") return new Response(JSON.stringify({ id: 555, account: { login: "alice-gh" } }), { status: 200 });
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };
  });
  after(async () => {
    global.fetch = saved;
    clearInstallationTokenCache();
    await s.close();
  });

  const setup = async (sess, ctx) => {
    const state = issueState(ctx, SECRET, { purpose: "install", session: sess.token });
    const res = await rawFetch(`${s.url}/auth/github/setup?installation_id=555&setup_action=install&state=${encodeURIComponent(state)}`, { headers: { cookie: sess.cookie }, redirect: "manual" });
    return res.headers.get("location") || "";
  };

  it("Alice подключает свою установку; Bob без своего приложения и со своим — нет", async () => {
    const alice = env.user("alice");
    const bob = env.user("bob");
    for (const [k, v] of Object.entries({ github_app_id: "111", github_app_slug: "alice-app", github_app_pem: alicePem })) alice.set(k, v);
    const sa = await session(s.url, env.platform, "alice");
    assert.match(await setup(sa, alice), /toast=github_connected/);
    assert.equal(alice.get("github_installation_id"), "555");

    const sb = await session(s.url, env.platform, "bob");
    assert.match(await setup(sb, bob), /error=/, "у Bob нет приложения");
    for (const [k, v] of Object.entries({ github_app_id: "222", github_app_slug: "bob-app", github_app_pem: bobPem })) bob.set(k, v);
    assert.match(await setup(sb, bob), /error=/, "приложение Bob не видит установку Alice");
    assert.equal(bob.get("github_installation_id"), "");
    // Ключ приложения Alice в ответах Bob не появляется
    const st = await sb.get("/api/state");
    assert.equal(JSON.stringify(st.body).includes("PRIVATE KEY"), false);
    assert.equal(st.body.github_app_id, "222");
  });
});

describe("Защита ресурсов маленького сервера", () => {
  it("потолок аккаунтов MAX_USERS", async () => {
    const env = makeEnv({ MAX_USERS: 2 });
    const s = await server(env.base);
    try {
      const reg = (u) => rawFetch(s.url + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: "long-enough-pass-1" }) }).then((r) => r.json().then((b) => [r.status, b.code]));
      assert.deepEqual(await reg("user1"), [201, undefined]);
      assert.deepEqual(await reg("user2"), [201, undefined]);
      assert.deepEqual(await reg("user3"), [403, "REGISTRATION_FULL"]);
      assert.equal(env.platform.countUsers(), 2);
    } finally {
      await s.close();
    }
  });

  it("не больше 10 действующих сессий на аккаунт: самые старые отзываются", () => {
    const env = makeEnv();
    const a = env.user("alice");
    const tokens = [];
    for (let i = 0; i < 12; i++) tokens.push(env.platform.createSession(a.userId, 60000).token);
    assert.equal(env.platform.sessionByToken(tokens[0]), null);
    assert.equal(env.platform.sessionByToken(tokens[1]), null);
    assert.ok(env.platform.sessionByToken(tokens[2]));
    assert.ok(env.platform.sessionByToken(tokens[11]));
    // Сессии другого аккаунта не затрагиваются
    const b = env.user("bob");
    const tb = env.platform.createSession(b.userId, 60000).token;
    for (let i = 0; i < 12; i++) env.platform.createSession(a.userId, 60000);
    assert.ok(env.platform.sessionByToken(tb));
  });

  it("потолок постов: фоновая проверка не создаёт пост и не теряет коммиты", async () => {
    const env = makeEnv({ MAX_POSTS_PER_USER: 2 });
    const a = env.user("alice");
    addDraft(a);
    addDraft(a);
    for (const [k, v] of Object.entries({ repo: "a/b", github_token: "t", ai_key: "k", ai_model: "m", debounce: "0", last_sha: "0".repeat(40) })) a.set(k, v);
    const c = { ...a, gh: async () => ({ ok: true, status: 200, json: async () => [{ sha: "a".repeat(40), commit: { message: "feat: x" }, parents: [{}] }, { sha: "0".repeat(40), commit: { message: "base" }, parents: [] }] }), buildInput: async () => "x" };
    const r = await poster.check(false, c, { silent: true });
    assert.equal(r.status, "error");
    assert.match(r.error, /предел постов/);
    assert.equal(a.countPosts(), 2);
    assert.equal(a.get("last_sha"), "0".repeat(40), "коммиты возьмёт следующая проверка");
  });

  it("часовой предел генераций ИИ; фоновый пост при этом не застревает в generating", async () => {
    const env = makeEnv({ AI_TASKS_PER_HOUR: 2 });
    const a = env.user("alice");
    for (const [k, v] of Object.entries({ ai_key: "k", ai_model: "m" })) a.set(k, v);
    const ids = [addDraft(a), addDraft(a), addDraft(a)];
    await poster.generate(ids[0], true, a);
    await poster.generate(ids[1], true, a);
    await assert.rejects(() => poster.generate(ids[2], true, a), (e) => e.status === 429 && e.code === "AI_HOURLY_LIMIT");
    assert.equal(a.post(ids[2]).status, "draft", "отказ до начала генерации пост не трогает");
    // Другой аккаунт не затронут
    const b = env.user("bob");
    for (const [k, v] of Object.entries({ ai_key: "k2", ai_model: "m" })) b.set(k, v);
    await poster.generate(addDraft(b), true, b);

    // Фоновая проверка при исчерпанном пределе: пост — failed с причиной, а не вечный generating
    for (const [k, v] of Object.entries({ repo: "a/b", github_token: "t", debounce: "0", last_sha: "0".repeat(40) })) a.set(k, v);
    const c = { ...a, gh: async () => ({ ok: true, status: 200, json: async () => [{ sha: "b".repeat(40), commit: { message: "feat: y" }, parents: [{}] }, { sha: "0".repeat(40), commit: { message: "base" }, parents: [] }] }), buildInput: async () => "x" };
    await poster.check(false, c, { silent: true });
    const p = a.getPosts()[0];
    assert.equal(p.status, "failed");
    assert.match(p.error, /Предел генераций ИИ/);
  });

  it("частота запросов к API одного аккаунта ограничена, другой аккаунт работает", async () => {
    const env = makeEnv({ API_REQUESTS_PER_5MIN: 5 });
    env.user("alice");
    env.user("bob");
    const s = await server(env.base);
    try {
      const sa = await session(s.url, env.platform, "alice");
      const sb = await session(s.url, env.platform, "bob");
      const statuses = [];
      for (let i = 0; i < 7; i++) statuses.push((await sa.get("/api/auth/me")).status);
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
      assert.equal((await sb.get("/api/auth/me")).status, 200);
    } finally {
      await s.close();
    }
  });

  it("журнал объявленного ограничен 2000 пунктами на аккаунт", () => {
    const env = makeEnv();
    const a = env.user("alice");
    a.addAnnounced(null, Array.from({ length: 2005 }, (_, i) => ({ name: "п" + i })));
    assert.equal(a.db.prepare("select count(*) c from announced_items where user_id=?").get(a.userId).c, 2000);
  });
});

describe("Публикация: повтор прерванной отправки и размер запросов", () => {
  it("прерванный пост повторно — только с явным подтверждением (409 POST_MAY_BE_SENT)", async () => {
    const env = makeEnv();
    const a = env.user("alice");
    a.set("tg_owner_chat_id", "111");
    a.set("channel_id", "-100555");
    env.rights["-100555"] = { 111: "administrator" };
    const id = Number(a.db.prepare("insert into posts(user_id,head,input,text,status,interrupted) values(?,'h','i','Пост','failed',1)").run(a.userId).lastInsertRowid);
    const s = await server(env.base);
    try {
      const sess = await session(s.url, env.platform, "alice");
      const r1 = await sess.post(`/api/posts/${id}/publish`, {});
      assert.equal(r1.status, 409);
      assert.equal(r1.body.code, "POST_MAY_BE_SENT");
      assert.equal(env.sends().length, 0);
      const r2 = await sess.post(`/api/posts/${id}/publish`, { confirm_resend: true });
      assert.equal(r2.status, 200);
      assert.equal(env.sends().length, 1);
      assert.equal(a.post(id).status, "sent");
    } finally {
      await s.close();
    }
  });

  it("тело запроса больше предела — 413 с понятным текстом", async () => {
    const env = makeEnv();
    env.user("alice");
    const s = await server(env.base);
    try {
      const sess = await session(s.url, env.platform, "alice");
      const r = await sess.post("/api/settings", { tone: "x".repeat(200 * 1024) });
      assert.equal(r.status, 413);
      assert.equal(r.body.error, "Запрос слишком большой");
    } finally {
      await s.close();
    }
  });

  it("стартовые пределы по умолчанию: 50 аккаунтов, 10 генераций в час, 1 генерация аккаунта одновременно", async () => {
    const env = makeEnv();
    const a = env.user("alice");
    for (const [k, v] of Object.entries({ ai_key: "k", ai_model: "m" })) a.set(k, v);
    // Одна генерация аккаунта за раз: вторая, пока идёт первая, — 429
    let release;
    const gate = new Promise((r) => (release = r));
    const ai = fakeAi({ text: "т" });
    const slow = { ...a, aiCall: (req) => gate.then(() => ai(req)) };
    const first = poster.generate(addDraft(a), true, slow);
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(() => poster.generate(addDraft(a), true, a), (e) => e.code === "AI_BUSY");
    release();
    await first;
    // 10 в час (первая уже засчитана)
    const errors = [];
    for (let i = 0; i < 10; i++) await poster.generate(addDraft(a), true, a).catch((e) => errors.push(e.code));
    assert.deepEqual(errors, ["AI_HOURLY_LIMIT"]);
    const s = await server(env.base);
    try {
      for (let i = 0; i < 49; i++) env.user("u" + i);
      const r = await rawFetch(s.url + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "late", password: "long-enough-pass-1" }) });
      assert.equal(r.status, 403, "51-й аккаунт при MAX_USERS по умолчанию");
    } finally {
      await s.close();
    }
  });
});
