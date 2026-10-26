// Восстановление доступа к аккаунту. Почты у аккаунтов нет, поэтому забытый пароль сбрасывает
// только оператор сервера (у кого есть доступ к нему), после того как убедился, что просит владелец аккаунта.
// Новый пароль задаётся здесь, все сессии аккаунта завершаются; данные аккаунта не меняются.
//
// На сервере: docker compose exec app node scripts/reset-password.js --username имя
// Пароль спросит скрытым вводом или возьмёт из NEW_PASSWORD (не из аргументов: их видно в списке процессов).
const path = require("path");
const readline = require("readline");
const { createDatabase } = require("../lib/db");
const auth = require("../lib/auth");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");

function askPassword(prompt) {
  if (process.env.NEW_PASSWORD) return Promise.resolve(process.env.NEW_PASSWORD);
  if (!process.stdin.isTTY) return Promise.reject(new Error("Нет терминала для ввода пароля: задайте NEW_PASSWORD"));
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
  const i = process.argv.indexOf("--username");
  const username = i === -1 ? "" : process.argv[i + 1] || "";
  if (!username) throw new Error("Укажите --username имя-аккаунта");

  const log = console.log;
  console.log = () => {};
  const platform = createDatabase(DB_PATH, process.env.ENCRYPTION_KEY);
  console.log = log;

  const user = platform.userByUsername(username);
  if (!user) throw new Error(`Аккаунт ${username} не найден`);
  const password = await askPassword(`Новый пароль для ${user.username}: `);
  const pw = auth.checkPassword(password, user.username);
  if (!pw.ok) throw new Error(pw.error);

  platform.setPasswordHash(user.id, await auth.hash(password));
  const revoked = platform.revokeUserSessions(user.id);
  platform.db.close();
  console.log(`Пароль аккаунта ${user.username} изменён, завершено сессий: ${revoked}. Передайте новый пароль владельцу по надёжному каналу и попросите сменить его в панели.`);
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
