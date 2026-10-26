const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { encrypt, decrypt } = require("./crypto");

const PLAIN = [
  "repo",
  "branch",
  "channel_id",
  "channel_title",
  "channel_username",
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
  "variants",
  "paused",
  "post_format",
  "project_name",
  "project_about",
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
  "variants",
  "paused",
  "post_format",
  "project_name",
  "project_about",
];

// Версия схемы базы: 2 — аккаунты (user_id). Её читают из заголовка файла deploy/rollback.sh и deploy/deploy.sh,
// чтобы не вернуть однопользовательский код на базу с данными нескольких аккаунтов
const SCHEMA_VERSION = 2;

// Ключи kv, которые принадлежат платформе. Остальное в kv — настройки прежней однопользовательской версии
const PLATFORM_KV_KEYS = ["tg_bot_info", "tg_token", "admin_password_hash", "session_version", "legacy_claimed_by"];
// Значения, на которых однопользовательская версия (до 2) не пускает никого: это не хеш пароля,
// а версия сессии не число. Так старый код, запущенный на этой базе, не покажет ничьих данных
const LEGACY_LOCK_HASH = "locked:multi-user-schema";
const LEGACY_LOCK_SESSION = "multi-user";

const DEF = {
  branch: "main",
  post_format: "story",
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
  variants: "3",
  paused: "0",
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
  db.pragma("foreign_keys = ON");
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

  // Подтверждения опасных действий в боте: одноразовый nonce с таймаутом
  db.exec(`
    create table if not exists bot_confirms(
      nonce text primary key,
      action text not null,
      payload text,
      expires_at integer not null
    );
    create table if not exists events(
      id integer primary key autoincrement,
      ts text default (datetime('now')),
      kind text not null,
      message text
    );
    create index if not exists idx_events_ts on events(ts);
    create table if not exists ai_usage(
      id integer primary key autoincrement,
      ts text default (datetime('now')),
      step text,
      model text,
      input_tokens integer,
      output_tokens integer,
      estimated integer default 0
    );
    create index if not exists idx_ai_usage_ts on ai_usage(ts);
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

  // ===== Пользователи и сессии (публичная многопользовательская платформа) =====
  // Пароли — только хеш scrypt. Сессии — только sha256 от случайного токена из cookie.
  db.exec(`
    create table if not exists users(
      id integer primary key autoincrement,
      username text not null,
      username_norm text not null unique,
      password_hash text not null,
      created_at text default (datetime('now')),
      updated_at text default (datetime('now'))
    );
    create table if not exists sessions(
      id integer primary key autoincrement,
      user_id integer not null references users(id) on delete cascade,
      token_hash text not null unique,
      created_at text default (datetime('now')),
      last_seen_at text,
      expires_at integer not null,
      revoked_at text
    );
    create index if not exists idx_sessions_user on sessions(user_id);
    create table if not exists user_settings(
      user_id integer not null references users(id) on delete cascade,
      k text not null,
      v text,
      primary key (user_id, k)
    );
    create table if not exists tg_link_codes(
      code_hash text primary key,
      user_id integer not null references users(id) on delete cascade,
      expires_at integer not null
    );
  `);
  // Чат Telegram, канал и установка GitHub принадлежат не больше чем одному аккаунту
  db.exec(`
    create unique index if not exists ux_settings_owner_chat on user_settings(v) where k = 'tg_owner_chat_id' and v <> '';
    create unique index if not exists ux_settings_channel on user_settings(v) where k = 'channel_id' and v <> '';
    create unique index if not exists ux_settings_installation on user_settings(v) where k = 'github_installation_id' and v <> '';
  `);

  // Владелец данных. Строки без user_id — данные прежней однопользовательской версии:
  // их не видит никто, пока владелец не заберёт их командой scripts/claim-legacy.js
  for (const table of ["posts", "announced_items", "bot_confirms", "events", "ai_usage"]) {
    try { db.exec(`alter table ${table} add column user_id integer references users(id);`); } catch {}
  }
  db.exec(`
    create index if not exists idx_posts_user on posts(user_id, id);
    create index if not exists idx_posts_user_status on posts(user_id, status);
    create index if not exists idx_announced_user on announced_items(user_id, created_at);
    create index if not exists idx_events_user on events(user_id, ts);
    create index if not exists idx_ai_usage_user on ai_usage(user_id, ts);
    create index if not exists idx_bot_confirms_user on bot_confirms(user_id);
  `);

  // Миграция существующих открытых значений (настройки прежней версии в kv)
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

  // ===== Защита от запуска однопользовательской версии на этой базе =====
  // 1) Настройки прежнего владельца (репозиторий, ключи, привязка бота) уходят из kv в legacy_settings:
  //    у старого кода не остаётся ни владельца бота, ни репозитория, ни ключей. Их забирает scripts/claim-legacy.js.
  // 2) Вход старого кода запирается, его прежние cookie перестают действовать.
  // 3) Версия схемы записывается в заголовок файла (PRAGMA user_version) — по ней откат отказывается
  //    возвращать старый код без копии базы, сделанной до обновления.
  db.exec("create table if not exists legacy_settings(k text primary key, v text)");
  db.transaction(() => {
    const keep = PLATFORM_KV_KEYS.map(() => "?").join(",");
    db.prepare(`insert or replace into legacy_settings(k, v) select k, v from kv where k not in (${keep})`).run(...PLATFORM_KV_KEYS);
    db.prepare(`delete from kv where k not in (${keep})`).run(...PLATFORM_KV_KEYS);
    const lock = db.prepare("insert into kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v");
    lock.run("admin_password_hash", LEGACY_LOCK_HASH);
    lock.run("session_version", LEGACY_LOCK_SESSION);
  })();
  // Блокировку не снять кодом однопользовательской версии (например, её scripts/reset-password.js):
  // значения можно только записать такими же, удалить или заменить их база не даст
  const lockMsg = "gh-tg-poster: база с аккаунтами, вход однопользовательской версии заперт";
  const lockCheck = (row) => `(${row}.k = 'admin_password_hash' and ${row}.v is not '${LEGACY_LOCK_HASH}') or (${row}.k = 'session_version' and ${row}.v is not '${LEGACY_LOCK_SESSION}')`;
  db.exec(`
    create trigger if not exists kv_legacy_lock_insert before insert on kv when ${lockCheck("new")}
      begin select raise(abort, '${lockMsg}'); end;
    create trigger if not exists kv_legacy_lock_update before update on kv
      when old.k in ('admin_password_hash', 'session_version') and (new.k is not old.k or ${lockCheck("new")})
      begin select raise(abort, '${lockMsg}'); end;
    create trigger if not exists kv_legacy_lock_delete before delete on kv when old.k in ('admin_password_hash', 'session_version')
      begin select raise(abort, '${lockMsg}'); end;
  `);
  if (db.pragma("user_version", { simple: true }) < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  // Заголовок файла — сразу на диск: скрипты отката читают версию, не открывая базу
  if (dbPath !== ":memory:") db.pragma("wal_checkpoint(TRUNCATE)");

  // Значение настройки: секреты шифруются при записи и расшифровываются при чтении
  const decode = (k, raw, d) => {
    if (raw === undefined || raw === null) return d;
    if (!SECRETS.includes(k)) return raw;
    const dec = decrypt(raw, encryptionKey);
    return dec === null ? d : dec;
  };
  const encode = (k, v) => {
    const str = String(v ?? "");
    return SECRETS.includes(k) && str ? encrypt(str, encryptionKey) : str;
  };
  const corrupted = (k, raw) => SECRETS.includes(k) && !!raw && raw.startsWith("enc:v1:") && decrypt(raw, encryptionKey) === null;

  // ===== Хранилище платформы (kv): сведения о боте, старый токен бота, данные прежней версии =====
  const getRaw = (k) => db.prepare("select v from kv where k=?").get(k)?.v;
  const setRaw = (k, v) => db.prepare("insert into kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v").run(k, String(v));
  const platformGet = (k, d = "") => decode(k, getRaw(k), d);
  const platformSet = (k, v) => setRaw(k, encode(k, v));

  // Токен бота, который раньше хранился в базе (зашифрованным или открытым текстом)
  const getLegacyBotToken = () => {
    const raw = getRaw("tg_token");
    if (!raw) return "";
    return decrypt(raw, encryptionKey) || "";
  };
  const hasLegacyBotToken = () => !!getRaw("tg_token");
  const deleteLegacyBotToken = () => db.prepare("delete from kv where k='tg_token'").run().changes;

  // ===== Пользователи =====
  const normalizeUsername = (u) => String(u ?? "").trim().toLowerCase();
  const createUser = (username, passwordHash) => {
    const name = String(username).trim();
    return Number(db.prepare("insert into users(username, username_norm, password_hash) values(?,?,?)").run(name, normalizeUsername(name), passwordHash).lastInsertRowid);
  };
  const userByUsername = (username) => db.prepare("select * from users where username_norm=?").get(normalizeUsername(username));
  const getUser = (id) => db.prepare("select id, username, created_at from users where id=?").get(id);
  const passwordHashOf = (id) => db.prepare("select password_hash from users where id=?").get(id)?.password_hash || null;
  const setPasswordHash = (id, hash) => db.prepare("update users set password_hash=?, updated_at=datetime('now') where id=?").run(hash, id);
  const countUsers = () => db.prepare("select count(*) as c from users").get().c;

  // ===== Сессии: в базе только sha256 токена; токен знает только браузер =====
  const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
  // Не больше MAX_SESSIONS действующих сессий на аккаунт: при новой самые старые отзываются
  const MAX_SESSIONS = 10;
  const createSession = (userId, ttlMs) => {
    const token = crypto.randomBytes(32).toString("base64url");
    const info = db.prepare("insert into sessions(user_id, token_hash, expires_at, last_seen_at) values(?,?,?,datetime('now'))").run(userId, tokenHash(token), Date.now() + ttlMs);
    db.prepare(`
      update sessions set revoked_at=datetime('now')
      where user_id=? and revoked_at is null and id not in (
        select id from sessions where user_id=? and revoked_at is null and expires_at > ? order by id desc limit ?
      )
    `).run(userId, userId, Date.now(), MAX_SESSIONS);
    return { token, id: Number(info.lastInsertRowid) };
  };
  // Действующая сессия: не отозвана и не истекла. → { session_id, user_id, username } | null
  const sessionByToken = (token) => {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    return db.prepare(`
      select s.id as session_id, s.user_id, u.username from sessions s join users u on u.id = s.user_id
      where s.token_hash = ? and s.revoked_at is null and s.expires_at > ?
    `).get(tokenHash(token), Date.now()) || null;
  };
  const revokeSession = (sessionId) => db.prepare("update sessions set revoked_at=datetime('now') where id=? and revoked_at is null").run(sessionId).changes;
  // Все сессии пользователя, кроме keepId (например, текущей после смены пароля). Чужие не трогаются
  const revokeUserSessions = (userId, keepId = null) =>
    db.prepare("update sessions set revoked_at=datetime('now') where user_id=? and revoked_at is null and id is not ?").run(userId, keepId).changes;
  const purgeSessions = () =>
    db.prepare("delete from sessions where expires_at < ? or revoked_at < datetime('now', '-1 day')").run(Date.now()).changes;

  // ===== Привязка Telegram: одноразовый код, в базе только его хеш =====
  const createTgLinkCode = (userId, ttlMs) => {
    const code = crypto.randomBytes(9).toString("base64url");
    db.transaction(() => {
      db.prepare("delete from tg_link_codes where user_id=? or expires_at < ?").run(userId, Date.now());
      db.prepare("insert into tg_link_codes(code_hash, user_id, expires_at) values(?,?,?)").run(tokenHash(code), userId, Date.now() + ttlMs);
    })();
    return { code, expiresAt: Date.now() + ttlMs };
  };
  // Код гасится при первой попытке: второй раз он не сработает. → user_id | null
  const consumeTgLinkCode = (code) => {
    if (!code || String(code).length > 64) return null;
    return db.transaction(() => {
      const row = db.prepare("select * from tg_link_codes where code_hash=?").get(tokenHash(code));
      if (!row) return null;
      db.prepare("delete from tg_link_codes where code_hash=?").run(row.code_hash);
      return row.expires_at > Date.now() ? row.user_id : null;
    })();
  };
  const clearTgLinkCodes = (userId) => db.prepare("delete from tg_link_codes where user_id=?").run(userId).changes;
  const userIdByOwnerChat = (chatId) =>
    db.prepare("select user_id from user_settings where k='tg_owner_chat_id' and v=?").get(String(chatId))?.user_id || null;
  // Аккаунты с привязанным Telegram: { user_id, chat_id }
  const ownerChats = () => db.prepare("select user_id, v as chat_id from user_settings where k='tg_owner_chat_id' and v<>''").all();
  // Аккаунты с выбранным репозиторием: их проверяет фоновый планировщик
  const usersWithRepo = () => db.prepare("select user_id from user_settings where k='repo' and v<>'' order by user_id").all().map((r) => r.user_id);

  /**
   * Посты, оставшиеся в статусе sending после падения или перезапуска процесса,
   * переводятся в failed: неизвестно, дошло ли сообщение до канала. Касается всех аккаунтов.
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

  /**
   * Данные одного аккаунта: тот же набор функций, что раньше был у единственного владельца,
   * но каждый запрос ограничен user_id. userId берётся только из проверенной сессии
   * (или из привязки Telegram), никогда из тела запроса.
   */
  const ANNOUNCED_MAX = 2000;
  function forUser(userId) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("forUser: нужен id пользователя");

    const rawOf = (k) => db.prepare("select v from user_settings where user_id=? and k=?").get(uid, k)?.v;
    const get = (k, d = "") => decode(k, rawOf(k), d);
    const set = (k, v) =>
      db.prepare("insert into user_settings(user_id,k,v) values(?,?,?) on conflict(user_id,k) do update set v=excluded.v").run(uid, k, encode(k, v));
    const isSecretCorrupted = (k) => corrupted(k, rawOf(k));

    const post = (id) => db.prepare("select * from posts where id=? and user_id=?").get(id, uid);

    const POST_COLUMNS = "id,head,input,text,status,error,created_at,sent_at,tg_message_id,kind,interrupted,commits,notes,meta,needs_review";
    const getPosts = ({ limit = 50, offset = 0, filter = "all" } = {}) => {
      if (filter && filter !== "all") {
        return db.prepare(`select ${POST_COLUMNS} from posts where user_id=? and status=? order by id desc limit ? offset ?`).all(uid, filter, limit, offset);
      }
      return db.prepare(`select ${POST_COLUMNS} from posts where user_id=? order by id desc limit ? offset ?`).all(uid, limit, offset);
    };

    const countPosts = (filter = "all") => {
      if (filter && filter !== "all") {
        return db.prepare("select count(*) as count from posts where user_id=? and status=?").get(uid, filter)?.count || 0;
      }
      return db.prepare("select count(*) as count from posts where user_id=?").get(uid)?.count || 0;
    };

    // tzOffsetMinutes — смещение часового пояса браузера (как Date#getTimezoneOffset: для UTC+3 это -180),
    // чтобы «отправлено сегодня» считалось по местной дате, а не по UTC
    const getCounts = (tzOffsetMinutes = 0) => {
      const shift = `${-Math.trunc(Number(tzOffsetMinutes) || 0)} minutes`;
      const byStatus = Object.fromEntries(db.prepare("select status, count(*) as c from posts where user_id=? group by status").all(uid).map((r) => [r.status, r.c]));
      const all = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const sent_today = db
        .prepare("select count(*) as c from posts where user_id=? and status='sent' and date(coalesce(sent_at, created_at), ?) = date('now', ?)")
        .get(uid, shift, shift)?.c || 0;
      const n = (st) => byStatus[st] || 0;
      return { all, total: all, draft: n("draft"), sent: n("sent"), skipped: n("skipped"), failed: n("failed"), rejected: n("rejected"), generating: n("generating"), sent_today };
    };

    const deletePost = (id) =>
      db.transaction(() => {
        if (!post(id)) return { changes: 0 };
        db.prepare("delete from post_commits where post_id=?").run(id);
        return db.prepare("delete from posts where id=? and user_id=?").run(id, uid);
      })();

    // Коммиты поста: только для своего поста
    const recordPostCommits = (postId, shas) => {
      if (!post(postId)) return;
      const ins = db.prepare("insert or ignore into post_commits(post_id, sha) values(?, ?)");
      for (const sha of shas) if (sha) ins.run(postId, String(sha).toLowerCase());
    };

    // Свои посты, в которых уже использованы коммиты: { sha: [id, …] }
    const postsForCommits = (shas) => {
      const list = [...new Set(shas.map((x) => String(x).toLowerCase()))];
      if (!list.length) return {};
      const rows = db
        .prepare(`select pc.sha, pc.post_id from post_commits pc join posts p on p.id = pc.post_id where p.user_id = ? and pc.sha in (${list.map(() => "?").join(",")}) order by pc.post_id`)
        .all(uid, ...list);
      const out = {};
      for (const r of rows) (out[r.sha] ||= []).push(r.post_id);
      return out;
    };

    // Коммиты, которые уже вошли в свои отправленные посты: автоматический режим их повторно не берёт
    const sentShas = (shas) => {
      const list = [...new Set(shas.map((x) => String(x).toLowerCase()))];
      if (!list.length) return new Set();
      const rows = db
        .prepare(`select distinct pc.sha from post_commits pc join posts p on p.id = pc.post_id where p.user_id = ? and p.status = 'sent' and pc.sha in (${list.map(() => "?").join(",")})`)
        .all(uid, ...list);
      return new Set(rows.map((r) => r.sha));
    };

    // ===== Журнал объявленного =====
    const addAnnounced = (postId, items) => {
      if (postId != null && !post(postId)) return;
      const ins = db.prepare("insert into announced_items(user_id, post_id, name, summary, shas) values(?,?,?,?,?)");
      db.transaction(() => {
        for (const it of items) ins.run(uid, postId ?? null, String(it.name), String(it.summary || ""), JSON.stringify(it.shas || []));
        // Журнал аккаунта — не больше ANNOUNCED_MAX пунктов: старые уходят
        db.prepare("delete from announced_items where user_id=? and id not in (select id from announced_items where user_id=? order by id desc limit ?)").run(uid, uid, ANNOUNCED_MAX);
      })();
    };
    const announcedForPost = (postId) => db.prepare("select id from announced_items where user_id=? and post_id=?").all(uid, postId).length;
    const deleteAnnouncedForPost = (postId) => db.prepare("delete from announced_items where user_id=? and post_id=?").run(uid, postId).changes;
    // Свежие записи за days дней, самые новые первыми
    const getAnnounced = (days = 90, limit = 500) =>
      db
        .prepare("select id, post_id, name, summary, shas, created_at from announced_items where user_id=? and created_at >= datetime('now', ?) order by created_at desc, id desc limit ?")
        .all(uid, `-${Math.max(1, Math.trunc(Number(days) || 90))} days`, limit);
    // Последние отправленные посты: модель видит, как и о чём уже писали
    const recentSentTexts = (limit = 3) =>
      db.prepare("select text from posts where user_id=? and status='sent' and text is not null order by coalesce(sent_at, created_at) desc, id desc limit ?").all(uid, limit).map((r) => r.text);

    // ===== Подтверждения в боте =====
    const createConfirm = (action, payload, ttlMs = 60000) => {
      const nonce = crypto.randomBytes(6).toString("hex");
      db.prepare("delete from bot_confirms where expires_at < ?").run(Date.now());
      db.prepare("insert into bot_confirms(user_id, nonce, action, payload, expires_at) values(?,?,?,?,?)").run(uid, nonce, action, JSON.stringify(payload ?? null), Date.now() + ttlMs);
      return nonce;
    };
    // Атомарно забирает своё подтверждение: второе нажатие получит null. { action, payload } | { expired: true } | null
    const takeConfirm = (nonce) =>
      db.transaction(() => {
        const row = db.prepare("select * from bot_confirms where nonce=? and user_id=?").get(String(nonce), uid);
        if (!row) return null;
        db.prepare("delete from bot_confirms where nonce=? and user_id=?").run(row.nonce, uid);
        if (row.expires_at < Date.now()) return { expired: true, action: row.action };
        return { action: row.action, payload: JSON.parse(row.payload || "null") };
      })();
    const dropConfirm = (nonce) => db.prepare("delete from bot_confirms where nonce=? and user_id=?").run(String(nonce), uid).changes;

    // ===== Журнал ошибок и учёт вызовов ИИ =====
    const logEvent = (kind, message) => {
      db.prepare("insert into events(user_id, kind, message) values(?,?,?)").run(uid, String(kind), String(message ?? "").slice(0, 500));
      db.prepare("delete from events where ts < datetime('now', '-60 days')").run();
    };
    const recentEvents = (hours = 24, limit = 50) =>
      db.prepare("select ts, kind, message from events where user_id=? and ts >= datetime('now', ?) order by id desc limit ?").all(uid, `-${Math.trunc(hours)} hours`, limit);
    const recordUsage = ({ step, model, input = 0, output = 0, estimated = false }) => {
      db.prepare("insert into ai_usage(user_id, step, model, input_tokens, output_tokens, estimated) values(?,?,?,?,?,?)").run(uid, step || "", model || "", Math.round(input) || 0, Math.round(output) || 0, estimated ? 1 : 0);
      // Учёт ИИ хранится 180 дней (статистика показывает 7 и 30)
      db.prepare("delete from ai_usage where user_id=? and ts < datetime('now', '-180 days')").run(uid);
    };
    const usageStats = (days) =>
      db.prepare("select count(*) as calls, coalesce(sum(input_tokens),0) as input, coalesce(sum(output_tokens),0) as output, coalesce(sum(estimated),0) as estimated from ai_usage where user_id=? and ts >= datetime('now', ?)").get(uid, `-${Math.trunc(days)} days`);
    const postStats = (days) => {
      const since = `-${Math.trunc(days)} days`;
      const one = (sql) => db.prepare(sql).get(uid, since)?.c || 0;
      return {
        created: one("select count(*) as c from posts where user_id=? and created_at >= datetime('now', ?)"),
        sent: one("select count(*) as c from posts where user_id=? and status='sent' and coalesce(sent_at, created_at) >= datetime('now', ?)"),
        skipped: one("select count(*) as c from posts where user_id=? and status='skipped' and created_at >= datetime('now', ?)"),
        rejected: one("select count(*) as c from posts where user_id=? and status='rejected' and created_at >= datetime('now', ?)"),
      };
    };

    return {
      db,
      dbPath,
      userId: uid,
      username: getUser(uid)?.username || "",
      platform: bundle,
      PLAIN,
      SECRETS,
      EDITABLE,
      DEF,
      get,
      set,
      isSecretCorrupted,
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
      createConfirm,
      takeConfirm,
      dropConfirm,
      logEvent,
      recentEvents,
      recordUsage,
      usageStats,
      postStats,
      // Токен бота — общий для платформы: только чтение старого значения для перехода
      getLegacyBotToken,
      hasLegacyBotToken,
    };
  }

  /**
   * Перенос данных прежней однопользовательской версии в аккаунт владельца (scripts/claim-legacy.js).
   * Забираются только строки без владельца и настройки из kv. Повторный запуск ничего не меняет.
   * → { posts, announced, events, usage, settings }
   */
  function claimLegacyData(userId) {
    const uid = Number(userId);
    if (!getUser(uid)) throw new Error("Пользователь не найден");
    return db.transaction(() => {
      const claimed = getRaw("legacy_claimed_by");
      if (claimed && Number(claimed) !== uid) throw new Error(`Данные прежней версии уже переданы аккаунту #${claimed}`);
      const out = {};
      for (const [name, table] of [["posts", "posts"], ["announced", "announced_items"], ["events", "events"], ["usage", "ai_usage"]]) {
        out[name] = db.prepare(`update ${table} set user_id=? where user_id is null`).run(uid).changes;
      }
      db.prepare("delete from bot_confirms where user_id is null").run();
      // Настройки переносятся как есть (секреты остаются зашифрованными тем же ключом).
      // Значения, уже заданные в аккаунте, не перезаписываются; занятые другим аккаунтом (канал, чат, установка)
      // не переносятся и остаются в legacy_settings — о них сообщается
      let settings = 0;
      out.kept = [];
      out.conflicts = [];
      const has = db.prepare("select 1 from user_settings where user_id=? and k=?");
      const ins = db.prepare("insert into user_settings(user_id,k,v) values(?,?,?)");
      const drop = db.prepare("delete from legacy_settings where k=?");
      for (const row of db.prepare("select k, v from legacy_settings order by k").all()) {
        if (has.get(uid, row.k)) {
          out.kept.push(row.k);
          continue;
        }
        try {
          ins.run(uid, row.k, row.v);
        } catch (err) {
          if (!/UNIQUE/i.test(err.message)) throw err;
          out.conflicts.push(row.k);
          continue;
        }
        drop.run(row.k);
        settings++;
      }
      const left = db.prepare("select count(*) as c from posts where user_id is null").get().c;
      if (left) throw new Error(`После переноса остались посты без владельца: ${left}`);
      setRaw("legacy_claimed_by", uid);
      out.settings = settings;
      return out;
    })();
  }
  // Сколько данных прежней версии ещё ждут владельца
  const legacyPending = () => ({
    posts: db.prepare("select count(*) as c from posts where user_id is null").get().c,
    settings: db.prepare("select count(*) as c from legacy_settings").get().c,
    claimed_by: getRaw("legacy_claimed_by") || null,
  });

  const bundle = {
    db,
    dbPath,
    PLAIN,
    SECRETS,
    EDITABLE,
    DEF,
    getRaw,
    setRaw,
    platformGet,
    platformSet,
    getLegacyBotToken,
    hasLegacyBotToken,
    deleteLegacyBotToken,
    normalizeUsername,
    createUser,
    userByUsername,
    getUser,
    passwordHashOf,
    setPasswordHash,
    countUsers,
    createSession,
    sessionByToken,
    revokeSession,
    revokeUserSessions,
    purgeSessions,
    createTgLinkCode,
    consumeTgLinkCode,
    clearTgLinkCodes,
    userIdByOwnerChat,
    ownerChats,
    usersWithRepo,
    recoverStuckSending,
    claimLegacyData,
    legacyPending,
    forUser,
  };
  return bundle;
}

module.exports = {
  SCHEMA_VERSION,
  LEGACY_LOCK_HASH,
  LEGACY_LOCK_SESSION,
  createDatabase,
  PLAIN,
  SECRETS,
  EDITABLE,
  DEF,
};
