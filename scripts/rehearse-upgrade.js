// Репетиция первого обновления до многопользовательской версии на КОПИИ базы. Рабочую базу не трогает:
// копия ещё раз копируется во временную папку, всё проверяется там, папка удаляется.
// Сеть не используется: Telegram, GitHub и ИИ заменены заглушками, которые падают при вызове.
//
//   node scripts/rehearse-upgrade.js <копия-базы.db> --username <имя-владельца>
// На сервере (до обновления, новым образом):
//   docker run --rm --env-file .env -v "$PWD/backups/rehearsal:/work" gh-tg-web:rehearsal \
//     node scripts/rehearse-upgrade.js /work/app.db --username <имя>
// Нужен тот же ENCRYPTION_KEY, что в production: по нему проверяется, что ключи и токены читаются после переноса.
// Пароли и ключи не печатаются. Код выхода 0 — все проверки прошли.
process.umask(0o077);

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? null : process.argv[i + 1];
};
const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

async function main() {
  const source = process.argv[2];
  const username = arg("--username");
  if (!source || !username) throw new Error("Использование: node scripts/rehearse-upgrade.js <копия-базы.db> --username <имя-владельца>");
  if (!process.env.ENCRYPTION_KEY) throw new Error("Нужен ENCRYPTION_KEY (тот же, что в production)");
  const real = path.resolve(source);
  if (real === path.resolve(ROOT, "data", "app.db")) throw new Error("Это рабочая база. Сделайте копию (deploy/backup.sh или scripts/backup-db.js) и укажите её");
  if (!fs.existsSync(real)) throw new Error(`Нет файла ${real}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-rehearsal-"));
  const file = path.join(work, "app.db");
  const src = new Database(real, { readonly: true, fileMustExist: true });
  await src.backup(file);
  src.close();
  const KEY = process.env.ENCRYPTION_KEY;
  const log = console.log;
  const silent = (fn) => {
    const saved = [console.log, console.warn];
    console.log = console.warn = () => {};
    try {
      return fn();
    } finally {
      [console.log, console.warn] = saved;
    }
  };

  try {
    // ===== 1. Снимок данных до обновления =====
    const before = new Database(file, { readonly: true });
    const tables = new Set(before.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    if (tables.has("users")) throw new Error("Копия уже в многопользовательской схеме: репетировать нечего");
    const POST_COLS = "id,head,input,text,status,error,created_at,sent_at,tg_message_id,kind,interrupted,commits,input_data,notes,meta,needs_review";
    const cols = new Set(before.prepare("pragma table_info(posts)").all().map((r) => r.name));
    const postCols = POST_COLS.split(",").filter((c) => cols.has(c)).join(",");
    const snap = {
      posts: before.prepare(`select ${postCols} from posts order by id`).all(),
      kv: Object.fromEntries(before.prepare("select k, v from kv").all().map((r) => [r.k, r.v])),
      announced: tables.has("announced_items") ? before.prepare("select count(*) c from announced_items").get().c : 0,
      events: tables.has("events") ? before.prepare("select count(*) c from events").get().c : 0,
      usage: tables.has("ai_usage") ? before.prepare("select count(*) c from ai_usage").get().c : 0,
      postCommits: tables.has("post_commits") ? before.prepare("select post_id || ':' || sha as k from post_commits").all().map((r) => r.k) : [],
    };
    before.close();
    log(`Копия: постов ${snap.posts.length}, настроек ${Object.keys(snap.kv).length}, журнал ${snap.announced}, событий ${snap.events}, учёт ИИ ${snap.usage}.`);

    // ===== 2. Новая версия открывает базу, регистрация закрыта =====
    const { createDatabase, SCHEMA_VERSION } = require(path.join(ROOT, "lib", "db"));
    const { createApp } = require(path.join(ROOT, "lib", "app"));
    const platform = silent(() => createDatabase(file, KEY));
    check("миграция схемы", platform.db.pragma("user_version", { simple: true }) === SCHEMA_VERSION, `user_version ${SCHEMA_VERSION}`);
    check("старые посты никому не принадлежат до переноса", platform.legacyPending().posts === snap.posts.length);
    const noNet = async () => {
      throw new Error("репетиция: сетевые вызовы запрещены");
    };
    const secret = crypto.randomBytes(32).toString("hex");
    const base = { platform, SESSION_SECRET: secret, ENCRYPTION_KEY: KEY, REGISTRATION_OPEN: false, TG_BOT_TOKEN: "", tg: noNet, gh: noNet, aiCall: noNet, buildInput: noNet };
    const server = http.createServer(createApp(base));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const json = (p, body, cookie) =>
      fetch(url + p, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const reg = await json("/api/auth/register", { username: "rehearsal-stranger", password: "stranger-pass-123" });
    check("REGISTRATION_OPEN=0: регистрация закрыта", reg.status === 403);
    check("до переноса аккаунтов нет", platform.countUsers() === 0);

    // ===== 3. Перенос владельца через CLI (как на сервере) =====
    const password = crypto.randomBytes(18).toString("base64url");
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "claim-legacy.js"), "--username", username], {
      env: { ...process.env, DB_PATH: file, ENCRYPTION_KEY: KEY, LEGACY_OWNER_PASSWORD: password },
      encoding: "utf8",
    });
    check("claim-legacy.js завершился без ошибок", /Проверка: постов у аккаунта/.test(out));
    for (const line of out.split("\n").filter((l) => /Перенесено|Проверка|НЕ перенесены|Оставлены/.test(l))) log("     " + line);

    // ===== 4. Сверка: каждый старый пост и каждая настройка — у владельца без изменений =====
    const reopened = new Database(file, { readonly: true });
    const owner = platform.userByUsername(username);
    const after = reopened.prepare(`select ${postCols}, user_id from posts order by id`).all();
    const sameContent = after.length === snap.posts.length && after.every((p, i) => {
      const { user_id: uid, ...rest } = p;
      return uid === owner.id && sha(rest) === sha(snap.posts[i]);
    });
    check("все посты у владельца, содержимое без изменений", sameContent, `${after.length} из ${snap.posts.length}`);
    check("постов без владельца не осталось", reopened.prepare("select count(*) c from posts where user_id is null").get().c === 0);
    const count = (t) => reopened.prepare(`select count(*) c from ${t} where user_id=?`).get(owner.id).c;
    check("журнал объявленного у владельца", count("announced_items") === snap.announced, String(snap.announced));
    check("события у владельца", count("events") === snap.events, String(snap.events));
    check("учёт ИИ у владельца", count("ai_usage") === snap.usage, String(snap.usage));
    // Новая версия при открытии дополняет связи из столбца commits; ни одна прежняя не должна пропасть
    const links = new Set(reopened.prepare("select post_id || ':' || sha as k from post_commits").all().map((r) => r.k));
    const lost = snap.postCommits.filter((k) => !links.has(k));
    check("связи постов с коммитами сохранены", lost.length === 0, `было ${snap.postCommits.length}, стало ${links.size}${lost.length ? ", потеряны: " + lost.length : ""}`);
    const PLATFORM = new Set(["tg_bot_info", "tg_token", "admin_password_hash", "session_version", "legacy_claimed_by"]);
    const settings = Object.fromEntries(reopened.prepare("select k, v from user_settings where user_id=?").all(owner.id).map((r) => [r.k, r.v]));
    const userKeys = Object.keys(snap.kv).filter((k) => !PLATFORM.has(k));
    const mismatched = userKeys.filter((k) => settings[k] !== snap.kv[k]);
    check("все настройки прежней версии у владельца, значения те же", mismatched.length === 0, mismatched.length ? "расходятся: " + mismatched.join(", ") : `${userKeys.length} ключей`);
    reopened.close();
    const ownerCtx = platform.forUser(owner.id);
    const secrets = ownerCtx.SECRETS.filter((k) => snap.kv[k]);
    const unreadable = secrets.filter((k) => ownerCtx.isSecretCorrupted(k) || !ownerCtx.get(k));
    check("ключи и токены расшифровываются текущим ENCRYPTION_KEY", unreadable.length === 0, unreadable.length ? "не читаются: " + unreadable.join(", ") : secrets.join(", ") || "секретов нет");
    for (const k of ["repo", "branch", "channel_id", "tg_owner_chat_id", "mode", "last_sha"]) {
      if (snap.kv[k] !== undefined) check(`настройка ${k} на месте`, ownerCtx.get(k) === snap.kv[k]);
    }

    // ===== 5. Владелец входит при закрытой регистрации и видит свои посты =====
    const login = await json("/api/auth/login", { username, password });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    check("владелец входит при закрытой регистрации", login.status === 200);
    const state = await (await fetch(url + "/api/state?limit=100", { headers: { cookie } })).json();
    check("владелец видит все свои посты", state.pagination?.total === snap.posts.length, `${state.pagination?.total}`);
    await new Promise((r) => server.close(r));

    // ===== 6. Регистрация открыта: новый человек видит пустую панель =====
    base.REGISTRATION_OPEN = true;
    const server2 = http.createServer(createApp(base));
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    const url2 = `http://127.0.0.1:${server2.address().port}`;
    const r2 = await fetch(url2 + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "rehearsal-stranger", password: "stranger-pass-123" }) });
    const c2 = (r2.headers.get("set-cookie") || "").split(";")[0];
    const s2 = await (await fetch(url2 + "/api/state?limit=100", { headers: { cookie: c2 } })).json();
    check("после открытия регистрации новый аккаунт создаётся", r2.status === 201);
    check("новый аккаунт не видит данных владельца", s2.pagination?.total === 0 && s2.settings?.repo === "" && !s2.settings?.ai_key_set && !s2.settings?.github_token_set);
    await new Promise((r) => server2.close(r));

    // ===== 7. Защита от отката =====
    const kv = Object.fromEntries(platform.db.prepare("select k, v from kv").all().map((r) => [r.k, r.v]));
    check("вход однопользовательской версии заперт", /^locked:/.test(kv.admin_password_hash) && kv.session_version === "multi-user");
    check("в kv не осталось настроек владельца", Object.keys(kv).every((k) => PLATFORM.has(k)), Object.keys(kv).join(", "));
    platform.db.close();
    // Те же байты 60–63 заголовка SQLite, что читает deploy/lib.sh (db_schema_version)
    const fd = fs.openSync(file, "r");
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 60);
    fs.closeSync(fd);
    const headerVersion = header.readUInt32BE(0);
    check("версия схемы читается из заголовка файла (для скриптов отката)", headerVersion === SCHEMA_VERSION, String(headerVersion));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  log(failed.length ? `\nНЕ ПРОЙДЕНО: ${failed.length} из ${results.length}. Обновлять production рано.` : `\nВсе проверки пройдены: ${results.length}. Временная копия удалена.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
