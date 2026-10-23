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
  "github_app_id",
  "github_app_slug",
  "github_app_base_url",
  "strict_check",
  "verify_model",
  "journal_days",
  "audience",
  "voice",
  "style_samples",
  "banned_words",
  "emoji",
  "cta",
];

// github_app_pem — закрытый ключ приложения GitHub, созданного кнопкой в панели.
// Токена бота здесь нет: он задаётся переменной TG_BOT_TOKEN. Старое значение tg_token
// из базы читает только getLegacyBotToken() для перехода.
const SECRETS = ["github_token", "ai_key", "github_app_pem"];

// Белый список настроек, которые можно менять через POST /api/settings.
// Служебное состояние (last_sha, pending_*, владелец бота, установка GitHub App, хеш пароля)
// меняется только самим сервером.
const EDITABLE = [
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
  "strict_check",
  "verify_model",
  "journal_days",
  "audience",
  "voice",
  "style_samples",
  "banned_words",
  "emoji",
  "cta",
];

const DEF = {
  branch: "main",
  ai_provider: "anthropic",
  mode: "approve",
  debounce: "10",
  poll_interval: "5",
  digest_time: "18:00",
  digest_tz: "Europe/Moscow",
  tg_notify_drafts: "0",
  strict_check: "1",
  verify_model: "",
  journal_days: "90",
  audience: "mixed",
  emoji: "few",
  cta: "none",
};

/**
 * База и её служебные файлы доступны только владельцу процесса (0600):
 * в них хеш пароля, секреты и история постов.
 */
function restrictFileModes(dbPath) {
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    } catch (err) {
      console.warn(`Не удалось ограничить права файла ${path.basename(f)}: ${err.message}`);
    }
  }
}

/**
 * Инициализация SQLite базы данных и миграция шифрования секретов.
 */
function createDatabase(dbPath = "data/app.db", encryptionKey = process.env.ENCRYPTION_KEY) {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  if (dbPath !== ":memory:") restrictFileModes(dbPath);

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
  // kind: 'commit' или 'digest' (нужно, чтобы перегенерация дайджеста шла с промптом дайджеста)
  try { db.exec("alter table posts add column kind text default 'commit';"); } catch {}
  // interrupted: 1, если отправка прервалась перезапуском и неизвестно, дошёл ли пост до канала
  try { db.exec("alter table posts add column interrupted integer default 0;"); } catch {}
  // commits: JSON-список коммитов поста [{ sha, message, date }] для показа в панели
  try { db.exec("alter table posts add column commits text;"); } catch {}
  // input_data: JSON входа для конвейера { commits: [{ sha, message }], files: [{ filename, additions, deletions, patch }] | null }
  try { db.exec("alter table posts add column input_data text;"); } catch {}
  // notes: пояснения автора { post: "", commits: { sha: "" } }
  try { db.exec("alter table posts add column notes text;"); } catch {}
  // meta: итог конвейера (факты, источники, проверка точности); needs_review: 1, если остались замечания
  try { db.exec("alter table posts add column meta text;"); } catch {}
  try { db.exec("alter table posts add column needs_review integer default 0;"); } catch {}

  // Журнал объявленного: что уже рассказали подписчикам (из отправленных постов и добавленное вручную)
  db.exec(`
    create table if not exists announced_items(
      id integer primary key autoincrement,
      post_id integer,
      name text not null,
      summary text,
      shas text,
      created_at text default (datetime('now'))
    );
    create index if not exists idx_announced_created on announced_items(created_at);
  `);

  // Какие коммиты вошли в какой пост: для бейджей «в посте #N» и защиты от дублей
  db.exec(`
    create table if not exists post_commits(
      post_id integer not null,
      sha text not null,
      primary key (post_id, sha)
    );
    create index if not exists idx_post_commits_sha on post_commits(sha);
  `);
  // Старые посты: все коммиты из столбца commits, а если его нет — хотя бы head
  db.exec(`
    insert or ignore into post_commits(post_id, sha)
      select p.id, lower(json_extract(j.value, '$.sha')) from posts p, json_each(p.commits) j
      where p.commits is not null and json_valid(p.commits) and json_extract(j.value, '$.sha') is not null;
    insert or ignore into post_commits(post_id, sha)
      select id, lower(head) from posts
      where head is not null and length(head) between 7 and 40 and lower(head) not glob '*[^0-9a-f]*'
        and id not in (select post_id from post_commits);
  `);

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

  // Токен бота, который раньше хранился в базе (зашифрованным или открытым текстом)
  const getLegacyBotToken = () => {
    const raw = getRaw("tg_token");
    if (!raw) return "";
    return decrypt(raw, encryptionKey) || "";
  };
  const hasLegacyBotToken = () => !!getRaw("tg_token");
  const deleteLegacyBotToken = () => db.prepare("delete from kv where k='tg_token'").run().changes;

  const post = (id) => db.prepare("select * from posts where id=?").get(id);

  const POST_COLUMNS = "id,head,input,text,status,error,created_at,sent_at,tg_message_id,kind,interrupted,commits,notes,meta,needs_review";
  const getPosts = ({ limit = 50, offset = 0, filter = "all" } = {}) => {
    if (filter && filter !== "all") {
      return db.prepare(`select ${POST_COLUMNS} from posts where status=? order by id desc limit ? offset ?`).all(filter, limit, offset);
    }
    return db.prepare(`select ${POST_COLUMNS} from posts order by id desc limit ? offset ?`).all(limit, offset);
  };

  const countPosts = (filter = "all") => {
    if (filter && filter !== "all") {
      return db.prepare("select count(*) as count from posts where status=?").get(filter)?.count || 0;
    }
    return db.prepare("select count(*) as count from posts").get()?.count || 0;
  };

  // tzOffsetMinutes — смещение часового пояса браузера (как Date#getTimezoneOffset: для UTC+3 это -180),
  // чтобы «отправлено сегодня» считалось по местной дате, а не по UTC
  const getCounts = (tzOffsetMinutes = 0) => {
    const shift = `${-Math.trunc(Number(tzOffsetMinutes) || 0)} minutes`;
    const all = db.prepare("select count(*) as c from posts").get()?.c || 0;
    const draft = db.prepare("select count(*) as c from posts where status='draft'").get()?.c || 0;
    const sent = db.prepare("select count(*) as c from posts where status='sent'").get()?.c || 0;
    const skipped = db.prepare("select count(*) as c from posts where status='skipped'").get()?.c || 0;
    const failed = db.prepare("select count(*) as c from posts where status='failed'").get()?.c || 0;
    const rejected = db.prepare("select count(*) as c from posts where status='rejected'").get()?.c || 0;
    const generating = db.prepare("select count(*) as c from posts where status='generating'").get()?.c || 0;
    const sent_today = db
      .prepare("select count(*) as c from posts where status='sent' and date(coalesce(sent_at, created_at), ?) = date('now', ?)")
      .get(shift, shift)?.c || 0;
    return { all, total: all, draft, sent, skipped, failed, rejected, generating, sent_today };
  };

  const deletePost = (id) =>
    db.transaction(() => {
      db.prepare("delete from post_commits where post_id=?").run(id);
      return db.prepare("delete from posts where id=?").run(id);
    })();

  const recordPostCommits = (postId, shas) => {
    const ins = db.prepare("insert or ignore into post_commits(post_id, sha) values(?, ?)");
    for (const sha of shas) if (sha) ins.run(postId, String(sha).toLowerCase());
  };

  // Посты, в которых уже использованы коммиты: { sha: [id, …] }
  const postsForCommits = (shas) => {
    const list = [...new Set(shas.map((x) => String(x).toLowerCase()))];
    if (!list.length) return {};
    const rows = db
      .prepare(`select sha, post_id from post_commits where sha in (${list.map(() => "?").join(",")}) order by post_id`)
      .all(...list);
    const out = {};
    for (const r of rows) (out[r.sha] ||= []).push(r.post_id);
    return out;
  };

  // Коммиты, которые уже вошли в отправленные посты: автоматический режим их повторно не берёт
  const sentShas = (shas) => {
    const list = [...new Set(shas.map((x) => String(x).toLowerCase()))];
    if (!list.length) return new Set();
    const rows = db
      .prepare(`select distinct pc.sha from post_commits pc join posts p on p.id = pc.post_id where p.status = 'sent' and pc.sha in (${list.map(() => "?").join(",")})`)
      .all(...list);
    return new Set(rows.map((r) => r.sha));
  };

  // ===== Журнал объявленного =====
  const addAnnounced = (postId, items) => {
    const ins = db.prepare("insert into announced_items(post_id, name, summary, shas) values(?,?,?,?)");
    db.transaction(() => {
      for (const it of items) ins.run(postId ?? null, String(it.name), String(it.summary || ""), JSON.stringify(it.shas || []));
    })();
  };
  const announcedForPost = (postId) => db.prepare("select id from announced_items where post_id=?").all(postId).length;
  const deleteAnnouncedForPost = (postId) => db.prepare("delete from announced_items where post_id=?").run(postId).changes;
  // Свежие записи за days дней, самые новые первыми
  const getAnnounced = (days = 90, limit = 500) =>
    db
      .prepare("select id, post_id, name, summary, shas, created_at from announced_items where created_at >= datetime('now', ?) order by created_at desc, id desc limit ?")
      .all(`-${Math.max(1, Math.trunc(Number(days) || 90))} days`, limit);
  // Последние отправленные посты: модель видит, как и о чём уже писали
  const recentSentTexts = (limit = 3) =>
    db.prepare("select text from posts where status='sent' and text is not null order by coalesce(sent_at, created_at) desc, id desc limit ?").all(limit).map((r) => r.text);

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
  const recoverStuckSending = () => {
    const sending = db.prepare("update posts set status='failed', interrupted=1, error=? where status='sending'")
      .run("Отправка прервана перезапуском сервера. Проверьте канал, прежде чем отправлять повторно.").changes;
    // Генерация, прерванная перезапуском (в том числе старые «черновики» без текста)
    const generating = db.prepare(
      "update posts set status='failed', error=? where status='generating' or (status='draft' and (text is null or trim(text)=''))"
    ).run("Генерация прервана перезапуском сервера. Нажмите «Другой вариант», чтобы написать пост заново.").changes;
    return sending + generating;
  };

  const recovered = recoverStuckSending();
  if (recovered) {
    console.warn(`[Восстановление] Постов, прерванных перезапуском: ${recovered}. Переведены в failed.`);
  }

  return {
    db,
    PLAIN,
    SECRETS,
    EDITABLE,
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
    recordPostCommits,
    postsForCommits,
    sentShas,
    addAnnounced,
    announcedForPost,
    deleteAnnouncedForPost,
    getAnnounced,
    recentSentTexts,
    isSecretCorrupted,
    getLegacyBotToken,
    hasLegacyBotToken,
    deleteLegacyBotToken,
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
  EDITABLE,
  DEF,
};
