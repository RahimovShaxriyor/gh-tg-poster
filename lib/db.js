const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { encrypt, decrypt } = require("./crypto");

const PLAIN = [
  "repo",
  "branch",
  "channel_id",
  "ai_provider",
  "ai_model",
  "mode",
  "debounce",
  "tone",
  "poll_interval",
  "digest_time",
  "digest_tz",
  "tg_notify_drafts",
  "tg_owner_chat_id",
  "tg_owner_username",
  "test_post_sent",
  "github_installation_id",
  "github_account_login",
];

const SECRETS = ["github_token", "tg_token", "ai_key"];

const DEF = {
  branch: "main",
  ai_provider: "anthropic",
  mode: "approve",
  debounce: "10",
  poll_interval: "5",
  digest_time: "18:00",
  digest_tz: "Europe/Moscow",
  tg_notify_drafts: "0",
};

/**
 * Инициализация SQLite базы данных и миграция шифрования секретов.
 */
function createDatabase(dbPath = "data/app.db", encryptionKey = process.env.ENCRYPTION_KEY) {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    create table if not exists kv(k text primary key, v text);
    create table if not exists posts(
      id integer primary key autoincrement,
      head text,
      input text,
      text text,
      status text default 'draft',
      error text,
      created_at text default (datetime('now')),
      tg_message_id integer,
      sent_at text
    );
  `);

  // Безопасная миграция колонок для существующих баз
  try { db.exec("alter table posts add column tg_message_id integer;"); } catch {}
  try { db.exec("alter table posts add column sent_at text;"); } catch {}

  // Миграция существующих открытых значений
  if (encryptionKey) {
    const selectStmt = db.prepare("select v from kv where k=?");
    const updateStmt = db.prepare("update kv set v=? where k=?");
    for (const secretKey of SECRETS) {
      const row = selectStmt.get(secretKey);
      if (row?.v && !row.v.startsWith("enc:v1:")) {
        const encrypted = encrypt(row.v, encryptionKey);
        updateStmt.run(encrypted, secretKey);
        console.log(`[Безопасность] Секрет ${secretKey} успешно зашифрован в базе данных.`);
      }
    }
  } else {
    console.warn("Предупреждение: ENCRYPTION_KEY не задан. Секреты в базе данных хранятся в открытом виде.");
  }

  const getRaw = (k) => db.prepare("select v from kv where k=?").get(k)?.v;
  const setRaw = (k, v) => db.prepare("insert into kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v").run(k, String(v));

  const get = (k, d = "") => {
    const raw = getRaw(k);
    if (raw === undefined || raw === null) return d;
    if (SECRETS.includes(k)) {
      const dec = decrypt(raw, encryptionKey);
      if (dec === null) return d;
      return dec;
    }
    return raw;
  };

  const isSecretCorrupted = (k) => {
    if (!SECRETS.includes(k)) return false;
    const raw = getRaw(k);
    if (!raw || !raw.startsWith("enc:v1:")) return false;
    return decrypt(raw, encryptionKey) === null;
  };

  const set = (k, v) => {
    const str = String(v ?? "");
    if (SECRETS.includes(k)) {
      const valToSave = str ? encrypt(str, encryptionKey) : "";
      return setRaw(k, valToSave);
    }
    return setRaw(k, str);
  };

  const post = (id) => db.prepare("select * from posts where id=?").get(id);

  const getPosts = ({ limit = 50, offset = 0, filter = "all" } = {}) => {
    if (filter && filter !== "all") {
      return db.prepare("select id,head,input,text,status,error,created_at,sent_at,tg_message_id from posts where status=? order by id desc limit ? offset ?").all(filter, limit, offset);
    }
    return db.prepare("select id,head,input,text,status,error,created_at,sent_at,tg_message_id from posts order by id desc limit ? offset ?").all(limit, offset);
  };

  const countPosts = (filter = "all") => {
    if (filter && filter !== "all") {
      return db.prepare("select count(*) as count from posts where status=?").get(filter)?.count || 0;
    }
    return db.prepare("select count(*) as count from posts").get()?.count || 0;
  };

  const getCounts = () => {
    const all = db.prepare("select count(*) as c from posts").get()?.c || 0;
    const draft = db.prepare("select count(*) as c from posts where status='draft'").get()?.c || 0;
    const sent = db.prepare("select count(*) as c from posts where status='sent'").get()?.c || 0;
    const skipped = db.prepare("select count(*) as c from posts where status='skipped'").get()?.c || 0;
    const failed = db.prepare("select count(*) as c from posts where status='failed'").get()?.c || 0;
    const rejected = db.prepare("select count(*) as c from posts where status='rejected'").get()?.c || 0;
    const sent_today = db.prepare("select count(*) as c from posts where status='sent' and date(coalesce(sent_at, created_at)) = date('now')").get()?.c || 0;
    return { all, total: all, draft, sent, skipped, failed, rejected, sent_today };
  };

  const deletePost = (id) => {
    return db.prepare("delete from posts where id=?").run(id);
  };

  const getAdminPasswordHash = () => getRaw("admin_password_hash");
  const setAdminPasswordHash = (hash) => setRaw("admin_password_hash", hash);

  const getSessionVersion = () => getRaw("session_version") || "1";
  const bumpSessionVersion = () => {
    const next = String((Number(getSessionVersion()) || 1) + 1);
    setRaw("session_version", next);
    return next;
  };

  /**
   * Посты, оставшиеся в статусе sending после падения или перезапуска процесса,
   * переводятся в failed: неизвестно, дошло ли сообщение до канала.
   */
  const recoverStuckSending = () =>
    db.prepare("update posts set status='failed', error=? where status='sending'")
      .run("Отправка прервана перезапуском сервера. Проверьте канал, прежде чем отправлять повторно.").changes;

  const recovered = recoverStuckSending();
  if (recovered) {
    console.warn(`[Восстановление] Постов, зависших в статусе sending: ${recovered}. Переведены в failed.`);
  }

  return {
    db,
    PLAIN,
    SECRETS,
    DEF,
    get,
    set,
    getRaw,
    setRaw,
    post,
    getPosts,
    countPosts,
    getCounts,
    deletePost,
    isSecretCorrupted,
    getAdminPasswordHash,
    setAdminPasswordHash,
    getSessionVersion,
    bumpSessionVersion,
    recoverStuckSending,
  };
}

module.exports = {
  createDatabase,
  PLAIN,
  SECRETS,
  DEF,
};
