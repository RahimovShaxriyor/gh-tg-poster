const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { createDatabase, SCHEMA_VERSION, LEGACY_LOCK_HASH } = require("../lib/db");
const { rawFetch } = require("./helpers/tenant");

// Откат на однопользовательскую версию не должен раскрыть данные аккаунтов:
// 1) база помечена версией схемы, скрипты отката по ней отказываются возвращать старый код без старой копии базы;
// 2) старый код, запущенный на новой базе вручную, никого не пускает и ничего не показывает.
const ROOT = path.join(__dirname, "..");
const OLD = "714d9c4"; // версия, которая сейчас работает в production
const KEY = "rollback-encryption-key";

const quiet = () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return () => Object.assign(console, saved);
};
const sh = (script, env = {}) => spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });

describe("Версия схемы в базе", () => {
  it("новая база помечена схемой 2, ключи прежней версии убраны из kv, вход старой версии заперт", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-schema-"));
    const file = path.join(dir, "app.db");
    // База прежней версии: настройки владельца в kv
    const legacy = new Database(file);
    legacy.exec("create table kv(k text primary key, v text)");
    legacy.prepare("insert into kv values('repo','owner/app'),('tg_owner_chat_id','777'),('admin_password_hash','scrypt$old'),('session_version','3'),('tg_token','1:legacy')").run();
    legacy.close();

    const restore = quiet();
    const p = createDatabase(file, KEY);
    restore();
    assert.equal(SCHEMA_VERSION, 2);
    assert.equal(p.db.pragma("user_version", { simple: true }), 2);
    const kv = Object.fromEntries(p.db.prepare("select k, v from kv").all().map((r) => [r.k, r.v]));
    assert.deepEqual(Object.keys(kv).sort(), ["admin_password_hash", "session_version", "tg_token"]);
    assert.equal(kv.admin_password_hash, LEGACY_LOCK_HASH);
    assert.equal(kv.session_version, "multi-user");
    const legacySettings = Object.fromEntries(p.db.prepare("select k, v from legacy_settings").all().map((r) => [r.k, r.v]));
    assert.equal(legacySettings.repo, "owner/app");
    assert.equal(legacySettings.tg_owner_chat_id, "777");
    p.db.close();

    // Версия видна прямо в заголовке файла — её читают скрипты отката
    const r = sh(`. "${ROOT}/deploy/lib.sh"; db_schema_version "${file}"; db_schema_version "${file}.missing"`, { APP_DIR: ROOT });
    assert.deepEqual(r.stdout.trim().split("\n"), ["2", "0"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Скрипты отката проверяют схему", () => {
  let dir;
  let app;
  let oldSha;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-rollback-"));
    app = path.join(dir, "app");
    fs.mkdirSync(path.join(app, "deploy"), { recursive: true });
    fs.mkdirSync(path.join(app, "lib"));
    fs.mkdirSync(path.join(app, "data"));
    fs.mkdirSync(path.join(app, "backups", "predeploy"), { recursive: true });
    for (const f of ["lib.sh", "rollback.sh"]) fs.copyFileSync(path.join(ROOT, "deploy", f), path.join(app, "deploy", f));
    const git = (...a) => execFileSync("git", ["-C", app, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    // «Старая» версия: lib/db.js без SCHEMA_VERSION
    fs.writeFileSync(path.join(app, "lib", "db.js"), "// однопользовательская версия\n");
    git("add", "-A");
    git("commit", "-qm", "old");
    oldSha = git("rev-parse", "HEAD");
    // «Новая» версия
    fs.writeFileSync(path.join(app, "lib", "db.js"), "const SCHEMA_VERSION = 2;\n");
    git("commit", "-qam", "new");
    fs.mkdirSync(path.join(app, ".deploy"));
    fs.writeFileSync(path.join(app, ".deploy", "previous_sha"), oldSha + "\n");
    fs.writeFileSync(path.join(app, ".env"), "X=1\n", { mode: 0o600 });
    // docker — заглушка: образы «есть», остальные команды записываются в журнал
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$@" >> "${dir}/docker.log"\nexit 0\n`, { mode: 0o755 });
    process.env.TEST_PATH_PREFIX = bin;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeDb = (file, version) => {
    const db = new Database(file);
    db.exec("create table posts(id integer primary key)");
    db.pragma(`user_version = ${version}`);
    db.close();
  };
  const rollback = (...args) =>
    spawnSync("sh", [path.join(app, "deploy", "rollback.sh"), "--yes", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${process.env.TEST_PATH_PREFIX}:${process.env.PATH}`, APP_DIR: app },
    });

  it("код старой версии понимает схему 1, новой — 2", () => {
    const r = sh(`. "${app}/deploy/lib.sh"; code_schema_version ${oldSha}; code_schema_version HEAD`, { APP_DIR: app });
    assert.deepEqual(r.stdout.trim().split("\n"), ["1", "2"]);
  });

  it("откат без базы на базу схемы 2 — отказ, ничего не меняется", () => {
    makeDb(path.join(app, "data", "app.db"), 2);
    const head = execFileSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const r = rollback();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /База в схеме 2 \(аккаунты\).*понимает только схему 1.*--with-db/s);
    assert.equal(execFileSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head, "код не откачен");
    assert.equal(fs.existsSync(path.join(dir, "docker.log")) && /compose.*up/.test(fs.readFileSync(path.join(dir, "docker.log"), "utf8")), false, "старый образ не запускался");
  });

  it("откат с базой: берётся только копия старой схемы; если её нет — отказ", () => {
    const pre = path.join(app, "backups", "predeploy");
    makeDb(path.join(pre, "app_20261026T100000Z_new.db"), 2);
    const noCopy = rollback("--with-db");
    assert.notEqual(noCopy.status, 0);
    assert.match(noCopy.stderr, /нет копии, которую понимает/);

    makeDb(path.join(pre, "app_20261025T100000Z_old.db"), 0);
    // более новая по времени копия — схемы 2, её пропускаем
    fs.utimesSync(path.join(pre, "app_20261025T100000Z_old.db"), new Date("2026-10-25"), new Date("2026-10-25"));
    fs.utimesSync(path.join(pre, "app_20261026T100000Z_new.db"), new Date("2026-10-26"), new Date("2026-10-26"));
    const r = sh(`. "${app}/deploy/lib.sh"; compatible_predeploy_copy 1; echo ---; compatible_predeploy_copy 2`, { APP_DIR: app });
    const [forOld, forNew] = r.stdout.split("---").map((x) => path.basename(x.trim()));
    assert.equal(forOld, "app_20261025T100000Z_old.db");
    assert.equal(forNew, "app_20261026T100000Z_new.db");
  });
});

describe(`Старый код (${OLD}) на базе с аккаунтами ничего не раскрывает`, () => {
  const hasOld = spawnSync("git", ["-C", ROOT, "cat-file", "-e", `${OLD}^{commit}`]).status === 0;
  let dir;
  let file;
  let ids;

  before(async () => {
    if (!hasOld) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-old-"));
    execFileSync("sh", ["-c", `git -C "${ROOT}" archive ${OLD} lib server.js package.json public .env.example | tar -x -C "${dir}"`]);
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, "data"));
    file = path.join(dir, "data", "app.db");

    // 1. База старой версии с данными владельца
    const restore = quiet();
    const oldDb = require(path.join(dir, "lib", "db.js")).createDatabase(file, KEY);
    for (const [k, v] of Object.entries({ repo: "owner/app", github_token: "ghp_owner", tg_owner_chat_id: "777", channel_id: "@owner_ch", mode: "approve" })) oldDb.set(k, v);
    oldDb.db.prepare("insert into posts(head,input,text,status) values('h','i','Пост владельца','draft')").run();
    oldDb.db.close();

    // 2. Обновление: новая версия, владелец забирает данные, регистрируются Alice и Bob
    const p = createDatabase(file, KEY);
    const owner = p.createUser("realowner", "scrypt$x");
    p.claimLegacyData(owner);
    const alice = p.forUser(p.createUser("alice", "scrypt$x"));
    const bob = p.forUser(p.createUser("bob", "scrypt$x"));
    ids = {
      alice: Number(alice.db.prepare("insert into posts(user_id,head,input,text,status) values(?,'h','i','Секрет Alice','draft')").run(alice.userId).lastInsertRowid),
      bob: Number(bob.db.prepare("insert into posts(user_id,head,input,text,status) values(?,'h','i','Секрет Bob','sent')").run(bob.userId).lastInsertRowid),
    };
    alice.set("ai_key", "sk-alice");
    p.db.close();
    restore();
  });
  after(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it("панель: вход по ADMIN_PASSWORD и старые cookie не работают", { skip: !hasOld && "нет коммита в истории" }, async () => {
    const port = 39100 + Math.floor(Math.random() * 500);
    const secret = "s".repeat(40);
    const env = { ...process.env, PORT: String(port), ADMIN_PASSWORD: "old-admin-password", SESSION_SECRET: secret, ENCRYPTION_KEY: KEY };
    delete env.TG_BOT_TOKEN;
    const child = spawn(process.execPath, [path.join(dir, "server.js")], { cwd: dir, env, stdio: "ignore" });
    try {
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 100));
        ok = await rawFetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
      }
      assert.ok(ok, "старая версия запустилась");
      const login = await rawFetch(`http://127.0.0.1:${port}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "old-admin-password" }) });
      assert.equal(login.status, 401, "вход по ADMIN_PASSWORD заперт");
      assert.equal(login.headers.get("set-cookie"), null);
      // cookie, которую старая версия выдала бы до обновления (версия сессии 1..3), подписанная тем же секретом
      for (const ver of ["1", "2", "3", "multi-user"]) {
        const exp = Date.now() + 60000;
        const sig = crypto.createHmac("sha256", secret).update(`${exp}.${ver}`).digest("hex");
        const st = await rawFetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie: `s=${exp}.${ver}.${sig}` } });
        assert.equal(st.status, 401, `cookie с версией ${ver}`);
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  });

  it("старый scripts/reset-password.js не снимает блокировку: падает и ничего не меняет", { skip: !hasOld && "нет коммита в истории" }, () => {
    execFileSync("sh", ["-c", `git -C "${ROOT}" archive ${OLD} scripts/reset-password.js | tar -x -C "${dir}"`]);
    const before = new Database(file, { readonly: true }).prepare("select k, v from kv order by k").all();
    const r = spawnSync(process.execPath, [path.join(dir, "scripts", "reset-password.js")], { encoding: "utf8", env: { ...process.env, DB_PATH: file } });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /вход однопользовательской версии заперт/);
    const db = new Database(file, { readonly: true });
    assert.deepEqual(db.prepare("select k, v from kv order by k").all(), before);
    db.close();
  });

  it("бот и фоновая проверка: владельца нет, чужие посты не показываются и не публикуются", { skip: !hasOld && "нет коммита в истории" }, async () => {
    const restore = quiet();
    const oldLib = (m) => require(path.join(dir, "lib", m));
    const db = oldLib("db.js").createDatabase(file, KEY);
    const calls = [];
    const ctx = { ...db, TG_BOT_TOKEN: "1:bot", tg: async (method, body) => (calls.push({ method, body }), { ok: true, result: { message_id: 1 } }), gh: async () => ({ ok: true, json: async () => [] }) };
    const { handleUpdate } = oldLib("telegram-bot.js");
    for (const text of ["/drafts", "/last 10", `/post ${ids.alice}`, "/status"]) {
      await handleUpdate({ message: { chat: { id: 777, type: "private" }, from: { id: 777 }, text } }, ctx, "1:bot");
    }
    await handleUpdate({ callback_query: { id: "c", from: { id: 777 }, data: `pub:${ids.alice}` } }, ctx, "1:bot");
    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text).join("\n");
    assert.doesNotMatch(texts, /Секрет/);
    assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0, "бот без владельца никому не отвечает");
    assert.equal(db.post(ids.alice).status, "draft", "пост Alice не опубликован");
    const check = await oldLib("poster.js").check(false, ctx, { silent: true });
    assert.equal(check.status, "not_configured", "у старого кода нет репозитория и ключей");
    db.db.close();
    restore();

    // Новая версия после такого запуска старой открывает базу как прежде
    const r2 = quiet();
    const p = createDatabase(file, KEY);
    r2();
    assert.equal(p.forUser(p.userByUsername("alice").id).get("ai_key"), "sk-alice");
    assert.equal(p.forUser(p.userByUsername("realowner").id).get("repo"), "owner/app");
    assert.equal(p.forUser(p.userByUsername("bob").id).getPosts()[0].text, "Секрет Bob");
    p.db.close();
  });
});

describe("Репетиция первого обновления (scripts/rehearse-upgrade.js)", () => {
  const hasOld = spawnSync("git", ["-C", ROOT, "cat-file", "-e", `${OLD}^{commit}`]).status === 0;

  it("на копии базы прежней версии все проверки проходят, исходный файл не меняется", { skip: !hasOld && "нет коммита в истории" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-rehearse-"));
    try {
      execFileSync("sh", ["-c", `git -C "${ROOT}" archive ${OLD} lib package.json | tar -x -C "${dir}"`]);
      fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
      const file = path.join(dir, "copy.db");
      // База, созданная самой прежней версией: секреты зашифрованы её кодом
      const restore = quiet();
      const old = require(path.join(dir, "lib", "db.js")).createDatabase(file, KEY);
      for (const [k, v] of Object.entries({ repo: "owner/app", branch: "main", github_token: "ghp_owner", ai_key: "sk-owner", tg_owner_chat_id: "777", channel_id: "@owner_ch", last_sha: "a".repeat(40) })) old.set(k, v);
      for (const st of ["sent", "draft", "failed"]) old.db.prepare("insert into posts(head,input,text,status,commits) values('h','i',?,?,?)").run("пост " + st, st, JSON.stringify([{ sha: "b".repeat(40), message: "m" }]));
      old.addAnnounced(1, [{ name: "Функция", summary: "s" }]);
      old.logEvent("check", "событие");
      old.db.pragma("wal_checkpoint(TRUNCATE)");
      old.db.close();
      restore();
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "rehearse-upgrade.js"), file, "--username", "realowner"], {
        encoding: "utf8",
        env: { ...process.env, ENCRYPTION_KEY: KEY },
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Все проверки пройдены: \d+/);
      assert.doesNotMatch(r.stdout, /FAIL/);
      assert.match(r.stdout, /ключи и токены расшифровываются текущим ENCRYPTION_KEY — github_token, ai_key/);
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), hash, "исходная копия не изменилась");
      // В выводе нет секретов
      for (const secret of ["ghp_owner", "sk-owner"]) assert.equal((r.stdout + r.stderr).includes(secret), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("рабочую базу data/app.db репетиция не трогает", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "rehearse-upgrade.js"), path.join(ROOT, "data", "app.db"), "--username", "x"], {
      encoding: "utf8",
      env: { ...process.env, ENCRYPTION_KEY: KEY },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Это рабочая база/);
  });
});
