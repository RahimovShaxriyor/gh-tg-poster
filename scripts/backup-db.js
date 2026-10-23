// Горячая копия базы средствами SQLite (учитывает журнал WAL) с проверкой целостности.
// Запуск: node scripts/backup-db.js <путь-к-копии>  (база берётся из data/app.db или DB_PATH)
process.umask(0o077);

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// DB_PATH нужен тестам; по умолчанию — рабочая база data/app.db
const SOURCE = process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");
const target = process.argv[2];

async function main() {
  if (!target) throw new Error("Укажите путь к файлу копии");
  if (!fs.existsSync(SOURCE)) throw new Error(`База не найдена: ${SOURCE}`);

  const db = new Database(SOURCE, { readonly: true, fileMustExist: true });
  await db.backup(target);
  db.close();

  // Копия — самостоятельный файл без журнала WAL: рядом не остаются -wal и -shm.
  // Приложение при открытии само включает WAL снова.
  const copy = new Database(target);
  copy.pragma("journal_mode = DELETE");
  const integrity = copy.pragma("integrity_check", { simple: true });
  const posts = copy.prepare("select count(*) as c from posts").get().c;
  copy.close();
  if (integrity !== "ok") throw new Error(`Копия повреждена: ${integrity}`);

  fs.chmodSync(target, 0o600);
  console.log(`Копия проверена: постов ${posts}`);
}

main().catch((err) => {
  try {
    fs.rmSync(target, { force: true });
  } catch {}
  console.error("Резервная копия не создана:", err.message);
  process.exit(1);
});
