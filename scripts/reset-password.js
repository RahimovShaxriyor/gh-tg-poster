// Сброс пароля, сменённого в панели: после него снова действует ADMIN_PASSWORD из .env,
// а все открытые сессии завершаются.
// На сервере: docker compose exec app node scripts/reset-password.js
const path = require("path");
const Database = require("better-sqlite3");

// DB_PATH нужен тестам; по умолчанию — рабочая база data/app.db
const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db"), { fileMustExist: true });
const removed = db.prepare("delete from kv where k='admin_password_hash'").run().changes;
const version = Number(db.prepare("select v from kv where k='session_version'").get()?.v) || 1;
db.prepare("insert into kv(k,v) values('session_version',?) on conflict(k) do update set v=excluded.v").run(String(version + 1));
db.close();

console.log(
  removed
    ? "Пароль из панели удалён. Входите с ADMIN_PASSWORD из .env. Все сессии завершены."
    : "Пароль в панели не менялся: действует ADMIN_PASSWORD из .env. Все сессии завершены."
);
