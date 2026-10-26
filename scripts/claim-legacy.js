// Перенос данных прежней однопользовательской версии (посты, настройки, ключи, привязки) в аккаунт владельца.
// После обновления до многопользовательской версии эти данные ничьи и не видны никому — в том числе
// первому, кто зарегистрируется на сайте. Забрать их может только тот, у кого есть доступ к серверу.
//
// На сервере (контейнер запущен):
//   docker compose exec app node scripts/claim-legacy.js --username имя --dry-run   # только показать
//   docker compose exec app node scripts/claim-legacy.js --username имя             # перенести
// Аккаунта нет — он создаётся (пароль спросит скрытым вводом или возьмёт из LEGACY_OWNER_PASSWORD).
// Аккаунт есть — нужен его пароль. Перед переносом делается копия базы рядом с ней (права 600).
// Повторный запуск ничего не меняет.
process.umask(0o077);

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createDatabase } = require("../lib/db");
const auth = require("../lib/auth");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? "";
}

// Пароль без эха в терминале; из переменной — для автоматизации (не из аргументов: их видно в списке процессов)
function askPassword(prompt) {
  if (process.env.LEGACY_OWNER_PASSWORD) return Promise.resolve(process.env.LEGACY_OWNER_PASSWORD);
  if (!process.stdin.isTTY) return Promise.reject(new Error("Нет терминала для ввода пароля: задайте LEGACY_OWNER_PASSWORD"));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const username = arg("--username");
  const dryRun = process.argv.includes("--dry-run");
  if (!username) throw new Error("Укажите --username имя-аккаунта-владельца");
  if (!fs.existsSync(DB_PATH)) throw new Error(`База не найдена: ${DB_PATH}`);

  const log = console.log;
  console.log = () => {};
  const platform = createDatabase(DB_PATH, process.env.ENCRYPTION_KEY);
  console.log = log;

  const pending = platform.legacyPending();
  console.log(`Данные прежней версии: постов без владельца ${pending.posts}, настроек ${pending.settings}.`);
  if (pending.claimed_by) console.log(`Уже переданы аккаунту #${pending.claimed_by}.`);
  if (dryRun) return;

  let user = platform.userByUsername(username);
  if (user) {
    const { ok } = await auth.verify(await askPassword(`Пароль аккаунта ${user.username}: `), user.password_hash);
    if (!ok) throw new Error("Неверный пароль: данные не перенесены");
  } else {
    const name = auth.checkUsername(username);
    if (!name.ok) throw new Error(name.error);
    const password = await askPassword(`Новый пароль для ${name.username}: `);
    const pw = auth.checkPassword(password, name.username);
    if (!pw.ok) throw new Error(pw.error);
    platform.createUser(name.username, await auth.hash(password));
    user = platform.userByUsername(name.username);
    console.log(`Аккаунт ${user.username} создан.`);
  }

  const backup = `${DB_PATH}.before-claim-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await platform.db.backup(backup);
  fs.chmodSync(backup, 0o600);
  console.log(`Копия базы: ${backup}`);

  const ownedBefore = platform.forUser(user.id).countPosts();
  const r = platform.claimLegacyData(user.id);
  console.log(`Перенесено в аккаунт ${user.username}: постов ${r.posts}, пунктов журнала ${r.announced}, событий ${r.events}, записей учёта ИИ ${r.usage}, настроек ${r.settings}.`);
  if (r.kept.length) console.log(`Оставлены значения аккаунта (в аккаунте уже были): ${r.kept.join(", ")}.`);
  if (r.conflicts.length) console.log(`НЕ перенесены — заняты другим аккаунтом: ${r.conflicts.join(", ")}. Они остались в legacy_settings.`);

  // Проверка результата: всё старое теперь у владельца, секреты читаются текущим ключом
  const owner = platform.forUser(user.id);
  const problems = [];
  const left = platform.legacyPending().posts;
  if (left) problems.push(`постов без владельца: ${left}`);
  if (owner.countPosts() !== ownedBefore + r.posts) problems.push(`постов у аккаунта ${owner.countPosts()}, ожидалось ${ownedBefore + r.posts}`);
  const broken = owner.SECRETS.filter((k) => owner.isSecretCorrupted(k));
  if (broken.length) problems.push(`не расшифровываются текущим ENCRYPTION_KEY: ${broken.join(", ")}`);
  const present = owner.SECRETS.filter((k) => owner.get(k));
  console.log(`Проверка: постов у аккаунта ${owner.countPosts()}, без владельца ${left}; секреты читаются: ${present.length ? present.join(", ") : "нет секретов"}.`);
  platform.db.close();
  if (problems.length) throw new Error("Проверка после переноса не прошла: " + problems.join("; ") + `. Копия базы до переноса: ${backup}`);
  console.log("Войдите на сайте под этим аккаунтом. ADMIN_PASSWORD из .env больше не используется.");
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
