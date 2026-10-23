const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.join(__dirname, "..", "screenshots");
const DB_PATH = path.join(__dirname, "..", "data", "app.db");

function seedMockData() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);

  // Settings
  const setKv = (k, v) => {
    db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  };

  setKv("repo", "acme-corp/super-backend");
  setKv("branch", "main");
  setKv("github_token", "ghp_mock_token_for_visual_tests");
  setKv("tg_token", "123456:mock_telegram_bot_token");
  setKv("channel_id", "@acme_updates");
  setKv("tg_owner_chat_id", "48291048");
  setKv("tg_owner_username", "@lead_dev");
  setKv("tg_notify_drafts", "1");
  setKv("ai_provider", "anthropic");
  setKv("ai_key", "sk-ant-api03-mock-key");
  setKv("ai_model", "claude-sonnet-5-5");
  setKv("mode", "approve");
  setKv("poll_interval", "5");
  setKv("debounce", "10");
  setKv("tone", "Пиши кратко и по существу, списком ключевых изменений для разработчиков.");
  setKv("test_post_sent", "1");

  // Sample Posts
  db.prepare("DELETE FROM posts").run();

  // 1. Draft Post
  const draftInput = JSON.stringify({
    commits: [
      { sha: "8f3b12a", message: "feat: добавить поддержку Telegram inline-кнопок для согласования" },
      { sha: "2c7d91e", message: "fix: исправить debounce-таймер при быстрой серии коммитов" }
    ],
    files: [
      "lib/services.js",
      "lib/poster.js",
      "server.js",
      "public/app.css"
    ]
  });

  const draftText = `🚀 Выкатили обновление панели анонсов:

• Добавили интерактивные кнопки согласования прямо в Telegram-бот
• Оптимизировали debounce-паузу между серией пушей
• Полностью переработали интерфейс на чистый CSS/JS без тяжелых фреймворков

Все изменения уже в main!`;

  db.prepare(`
    INSERT INTO posts (id, status, text, input, created_at)
    VALUES (101, 'draft', ?, ?, datetime('now', '-5 minutes'))
  `).run(draftText, draftInput);

  // 2. Sent Post
  const sentText = `⚡️ Релиз v2.4.0: ускорили сборку Docker-образов и обновили базовый образ до Node.js 22 LTS.`;
  db.prepare(`
    INSERT INTO posts (id, status, text, tg_message_id, sent_at, created_at)
    VALUES (100, 'sent', ?, 1420, datetime('now', '-2 hours'), datetime('now', '-2 hours'))
  `).run(sentText);

  // 3. Failed Post
  db.prepare(`
    INSERT INTO posts (id, status, text, error, created_at)
    VALUES (99, 'failed', 'Черновой текст поста', 'Telegram: Bad Request: chat not found (проверьте права бота в канале)', datetime('now', '-4 hours'))
  `).run();

  // 4. Skipped Post
  db.prepare(`
    INSERT INTO posts (id, status, text, created_at)
    VALUES (98, 'skipped', null, datetime('now', '-6 hours'))
  `).run();

  db.close();
  console.log("Тестовые данные успешно подготовлены в data/app.db");
}

async function main() {
  seedMockData();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const widths = [
    { width: 390, height: 844, name: "390" },
    { width: 1280, height: 850, name: "1280" },
    { width: 1920, height: 1080, name: "1920" },
  ];

  const colorSchemes = ["light", "dark"];

  for (const w of widths) {
    for (const cs of colorSchemes) {
      console.log(`Создаём скриншоты: ширина ${w.name}px, тема ${cs}...`);
      const context = await browser.newContext({
        viewport: { width: w.width, height: w.height },
        colorScheme: cs,
      });
      const page = await context.newPage();

      await page.goto("http://127.0.0.1:3000/");

      // Проверяем, виден ли экран логина
      const pwInput = await page.$("#pw");
      if (pwInput && await pwInput.isVisible()) {
        await page.fill("#pw", "12345678");
        await page.click("#go");
        await page.waitForSelector("#view-posts.active", { timeout: 8000 });
      }

      await page.waitForTimeout(600);

      // 1. Скриншот вкладки «Посты» (с черновиком, отправленным постом и ошибкой)
      const postsPath = path.join(OUT_DIR, `posts-${w.name}-${cs}.png`);
      await page.screenshot({ path: postsPath, fullPage: false });
      console.log(`  ✓ Сохранён: ${postsPath}`);

      // 2. Переключаемся на вкладку «Настройки»
      await page.click("#tab-settings");
      await page.waitForSelector("#view-settings.active", { timeout: 4000 });
      await page.waitForTimeout(400);

      const settingsPath = path.join(OUT_DIR, `settings-${w.name}-${cs}.png`);
      await page.screenshot({ path: settingsPath, fullPage: false });
      console.log(`  ✓ Сохранён: ${settingsPath}`);

      await context.close();
    }
  }

  await browser.close();
  console.log("\nВсе 12 скриншотов успешно созданы в папке screenshots/!");
}

main().catch((err) => {
  console.error("Ошибка при создании скриншотов:", err);
  process.exit(1);
});
