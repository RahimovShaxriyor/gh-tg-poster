// Скриншоты панели в разных состояниях, ширинах и темах.
// Рабочую базу не трогает: сервер запускается во временной папке со своей базой,
// а GitHub, Telegram и ИИ подменяются заглушкой, поэтому никакие запросы наружу не уходят.
//
// Запуск: node scripts/screenshots.js docs/screens/after
// Chrome: переменная CHROME_PATH или стандартный путь для macOS, Linux и Windows.

const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.resolve(process.argv[2] || path.join(ROOT, "screenshots"));
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = crypto.randomBytes(12).toString("hex");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];
const THEMES = ["light", "dark"];

// Заглушка внешних API, подключается к серверу через node -r
const STUB = `
global.fetch = async (url) => {
  url = String(url);
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("http://127.0.0.1")) throw new Error("not stubbed");
  if (url.includes("api.telegram.org")) {
    if (url.endsWith("/getUpdates")) { await new Promise((r) => setTimeout(r, 20000)); return J({ ok: true, result: [] }); }
    if (url.endsWith("/getMe")) return J({ ok: true, result: { id: 1, username: "release_notes_bot" } });
    return J({ ok: true, result: { message_id: 1, status: "administrator" } });
  }
  if (url.includes("api.github.com")) {
    if (url.includes("/user/repos")) return J([{ full_name: "anna-dev/notekeeper", default_branch: "main" }]);
    if (url.includes("/commits")) return J([{ sha: "4f2a9c1e7b", parents: [{}], commit: { message: "fix: экспорт", committer: { date: new Date().toISOString() } } }]);
    return J({ login: "anna-dev" });
  }
  return J({ content: [{ type: "text", text: "Готово" }], stop_reason: "end_turn" });
};`;

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString().replace("T", " ").slice(0, 19);
const commitsJson = (list) => JSON.stringify(list.map(([sha, message, h]) => ({ sha, message, date: new Date(Date.now() - h * 3600e3).toISOString() })));

const POSTS = [
  {
    key: "draft",
    status: "draft",
    h: 0.4,
    text: "В «Заметках» появился экспорт в Markdown: откройте меню заметки → «Экспорт», и файл сразу скачается. Списки и ссылки сохраняются как есть.\n\nЕщё поправили поиск: он больше не теряет заметки с ё в названии.\n\nПодробности: https://github.com/anna-dev/notekeeper/releases",
    commits: [["4f2a9c1e7b", "feat: экспорт заметки в Markdown", 0.6], ["a81c03d9e2", "fix: поиск по словам с ё", 0.9]],
  },
  {
    key: "error",
    status: "failed",
    h: 5,
    text: "Тёмная тема теперь включается автоматически вместе с системной.",
    error: "Telegram: Forbidden: bot is not a member of the channel chat",
    commits: [["c4d5e6f7a8", "feat: авто тёмная тема", 5.2]],
  },
  {
    key: "sent",
    status: "sent",
    h: 26,
    text: "Заметки синхронизируются между устройствами за пару секунд, а не по таймеру раз в минуту.",
    tg: 214,
    commits: [["0b1c2d3e4f", "perf: синхронизация через websocket", 26.5], ["9a8b7c6d5e", "chore: обновлены зависимости", 27]],
  },
  { key: "skipped", status: "skipped", h: 30, text: null, commits: [["1122334455", "ci: кеш npm в GitHub Actions", 30.2]] },
  { key: "rejected", status: "rejected", h: 52, text: "Обновили README.", commits: [["6677889900", "docs: README", 52.3]] },
  { key: "sent2", status: "sent", h: 75, text: "Добавили закреплённые заметки: они всегда наверху списка.", tg: 198, commits: [["aa11bb22cc", "feat: закрепление заметок", 75.5]] },
];

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome не найден: укажите путь в переменной CHROME_PATH");
  return found;
}

function seedSettings(db) {
  const settings = {
    repo: "anna-dev/notekeeper",
    branch: "main",
    github_token: "ghp_screenshots_fake_token",
    tg_token: "1:screenshots-fake",
    channel_id: "@notekeeper_news",
    tg_owner_chat_id: "1001",
    tg_owner_username: "@anna",
    ai_provider: "anthropic",
    ai_key: "sk-ant-screenshots-fake",
    ai_model: "claude-sonnet-5-5",
    mode: "approve",
    test_post_sent: "1",
    last_sha: "4f2a9c1e7b",
    last_check: new Date(Date.now() - 3 * 60e3).toISOString(),
  };
  for (const [k, v] of Object.entries(settings)) db.set(k, v);
}

function seedPosts(db, posts) {
  db.db.prepare("delete from posts").run();
  const ids = {};
  const insert = db.db.prepare(
    "insert into posts(head,input,text,status,error,tg_message_id,sent_at,created_at,commits) values(?,?,?,?,?,?,?,?,?)"
  );
  for (const p of [...posts].reverse()) {
    const created = hoursAgo(p.h);
    const info = insert.run(
      p.commits[0][0], "Коммиты:\n" + p.commits.map((c) => "- " + c[1]).join("\n"), p.text, p.status, p.error || null,
      p.tg || null, p.status === "sent" ? created.replace(" ", "T") + "Z" : null, created, commitsJson(p.commits)
    );
    ids[p.key] = Number(info.lastInsertRowid);
  }
  return ids;
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Сервер не запустился");
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gtw-screens-"));
  fs.mkdirSync(path.join(work, "data"));
  fs.writeFileSync(path.join(work, "stub.js"), STUB);
  const env = {
    ...process.env,
    PORT: String(PORT),
    ADMIN_PASSWORD: PASSWORD,
    SESSION_SECRET: crypto.randomBytes(24).toString("hex"),
    ENCRYPTION_KEY: crypto.randomBytes(24).toString("hex"),
    DOMAIN: "notes.example.org",
  };

  const { createDatabase } = require(path.join(ROOT, "lib", "db"));
  const log = console.log;
  console.log = () => {};
  const db = createDatabase(path.join(work, "data", "app.db"), env.ENCRYPTION_KEY);
  console.log = log;
  seedSettings(db);

  const server = spawn(process.execPath, ["-r", path.join(work, "stub.js"), path.join(ROOT, "server.js")], {
    cwd: work,
    env,
    stdio: "ignore",
  });

  let browser;
  try {
    await waitForServer();
    const login = await fetch(BASE + "/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookieValue = login.headers.get("set-cookie").split(";")[0].slice(2);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    browser = await chromium.launch({ executablePath: findChrome(), headless: true });

    const shoot = async (name, { width, height }, theme, prepare) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce" });
      await context.addCookies([{ name: "s", value: cookieValue, url: BASE }]);
      const page = await context.newPage();
      await prepare(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${name}-${width}-${theme}.png`) });
      await context.close();
    };

    const states = [];
    for (const size of WIDTHS) {
      for (const theme of THEMES) {
        states.push(["empty", size, theme, async (page) => {
          seedPosts(db, []);
          await page.goto(BASE + "/#posts");
          await page.waitForTimeout(700);
        }]);
        for (const key of ["draft", "sent", "error"]) {
          states.push([key, size, theme, async (page) => {
            const ids = seedPosts(db, POSTS);
            await page.goto(`${BASE}/#posts/${ids[key]}`);
            await page.waitForTimeout(700);
          }]);
        }
        states.push(["loading", size, theme, async (page) => {
          seedPosts(db, POSTS);
          await page.route("**/api/state*", () => {}); // ответ не приходит: остаётся состояние загрузки
          await page.goto(BASE + "/#posts");
          await page.waitForTimeout(400);
        }]);
        states.push(["settings", size, theme, async (page) => {
          seedPosts(db, POSTS);
          await page.goto(BASE + "/#settings");
          await page.waitForTimeout(700);
        }]);
      }
    }

    for (const [name, size, theme, prepare] of states) {
      await shoot(name, size, theme, prepare);
      console.log(`Сохранён: ${name}-${size.width}-${theme}.png`);
    }
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    db.db.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Скриншоты не созданы:", err.message);
  process.exit(1);
});
