// Проверка файла базы перед восстановлением: PRAGMA integrity_check и число постов.
// Запуск: node scripts/check-db.js <путь-к-файлу>. Файл копируется во временную папку и открывается
// только для чтения: исходник (в том числе на томе только для чтения) не меняется.
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error("Файл базы не найден:", source || "(не указан)");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-db-"));
const copy = path.join(dir, "check.db");
try {
  fs.copyFileSync(source, copy);
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const posts = db.prepare("select count(*) as c from posts").get().c;
  const settings = db.prepare("select count(*) as c from kv").get().c;
  db.close();
  if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
  console.log(`База в порядке: integrity_check ok, постов ${posts}, настроек ${settings}`);
} catch (err) {
  console.error("База повреждена или это не база приложения:", err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
