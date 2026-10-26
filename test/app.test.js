const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDatabase } = require("../lib/db");
const { createApp } = require("../lib/app");
const { buildInput, ai } = require("../lib/services");
const { publish, generate, check } = require("../lib/poster");
const { encrypt, decrypt } = require("../lib/crypto");
const { anthropicFetch } = require("./helpers/fake-ai");

describe("gh-tg-web тесты", () => {
  const TEST_PASS = "admin-secret-password-123";
  const TEST_KEY = "test-encryption-key-for-database";
  let server;
  let baseUrl;
  let testCtx;
  let originalFetch;
  let mockFetchHandler;

  before(async () => {
    originalFetch = global.fetch;
    global.fetch = async (...args) => {
      const url = String(args[0] || "");
      if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return originalFetch(...args);
      }
      if (mockFetchHandler) {
        return mockFetchHandler(...args);
      }
      return originalFetch(...args);
    };

    const dbBundle = createDatabase(":memory:", TEST_KEY);

    testCtx = {
      ...dbBundle,
      ADMIN_PASSWORD: TEST_PASS,
      SESSION_SECRET: TEST_PASS,
      ENCRYPTION_KEY: TEST_KEY,
      gh: async (p, token) => {
        return global.fetch("https://api.github.com" + p, {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      tg: async (m, body, token) => {
        const res = await global.fetch(`https://api.telegram.org/bot${token}/${m}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.json();
      },
      deleteWebhook: async (token) => {
        return { ok: true, result: true };
      },
      ai: (input, force, opts) => ai(input, force, opts),
      buildInput: (repo, base, head, msgs, token) => buildInput(repo, base, head, msgs, token),
    };

    const app = createApp(testCtx);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    global.fetch = originalFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  afterEach(() => {
    mockFetchHandler = null;
  });

  // 1. Вход с неверным и верным паролем
  it("вход: неверный пароль возвращает 401, верный возвращает 200 и cookie", async () => {
    const badRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(badRes.status, 401);
    const badJson = await badRes.json();
    assert.equal(badJson.error, "Неверный пароль");

    const okRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASS }),
    });
    assert.equal(okRes.status, 200);
    const setCookie = okRes.headers.get("set-cookie");
    assert.ok(setCookie && setCookie.includes("s="));
  });

  // 2. 401 на /api без cookie
  it("запрос к /api без авторизационной cookie возвращает 401", async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error, "auth");
  });

  // Вспомогательная функция для получения сессионной cookie
  async function getAuthCookie() {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASS }),
    });
    const header = res.headers.get("set-cookie");
    return header.split(";")[0];
  }

  // 3. Сохранение настроек (секреты не возвращаются в /api/state)
  it("сохранение настроек: секреты шифруются и не возвращаются в /api/state", async () => {
    const cookie = await getAuthCookie();

    const saveRes = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        repo: "user/cool-project",
        branch: "main",
        github_token: "ghp_super_secret_token_123",
        tg_token: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        ai_key: "sk-ant-api03-secret-ai-key",
      }),
    });
    assert.equal(saveRes.status, 200);

    const stateRes = await fetch(`${baseUrl}/api/state`, {
      headers: { cookie },
    });
    assert.equal(stateRes.status, 200);
    const stateText = await stateRes.text();
    const state = JSON.parse(stateText);

    assert.equal(state.settings.repo, "user/cool-project");
    assert.equal(state.settings.github_token_set, true);
    assert.equal(state.settings.ai_key_set, true);

    // Токен бота через настройки больше не принимается: он задаётся только TG_BOT_TOKEN в .env
    assert.equal(testCtx.getRaw("tg_token"), undefined);
    assert.equal(state.settings.tg_token_set, undefined);
    assert.equal(stateText.includes("ABC-DEF1234ghIkl"), false);

    // Секреты НЕ должны возвращаться
    assert.equal(state.settings.github_token, undefined);
    assert.equal(state.settings.tg_token, undefined);
    assert.equal(state.settings.ai_key, undefined);

    // В базе данных секрет зашифрован
    const rawVal = testCtx.getRaw("github_token");
    assert.ok(rawVal.startsWith("enc:v1:"));
    assert.notEqual(rawVal, "ghp_super_secret_token_123");

    // Но через decrypt возвращается исходное значение
    assert.equal(testCtx.get("github_token"), "ghp_super_secret_token_123");
  });

  // 4. Весь цикл «новый коммит -> debounce -> пост -> draft»
  it("полный цикл: новый коммит -> debounce -> пост -> draft", async () => {
    testCtx.set("repo", "user/project");
    testCtx.set("github_token", "ghp_test");
    testCtx.set("ai_provider", "anthropic");
    testCtx.set("ai_key", "sk-test");
    testCtx.set("ai_model", "claude-3-5-sonnet");
    testCtx.set("mode", "approve");
    testCtx.set("debounce", "10");
    testCtx.set("last_sha", "");
    testCtx.set("pending_head", "");

    // 1-й вызов: первый запуск запоминает c0
    mockFetchHandler = async (url) => {
      const u = String(url);
      if (u.includes("/commits?")) {
        return new Response(JSON.stringify([{ sha: "c0", commit: { message: "init" }, parents: [] }]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    await check(false, testCtx);
    assert.equal(testCtx.get("last_sha"), "c0");
    assert.equal(testCtx.countPosts(), 0);

    // 2-й вызов: появился новый коммит c1
    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("/commits?")) {
        return new Response(
          JSON.stringify([
            { sha: "c1", commit: { message: "feat: добавить корзину покупок" }, parents: [{ sha: "c0" }] },
            { sha: "c0", commit: { message: "init" }, parents: [] },
          ]),
          { status: 200 }
        );
      }
      if (u.includes("/compare/")) {
        return new Response(
          JSON.stringify({
            files: [{ filename: "cart.js", additions: 50, deletions: 5, patch: "+function addToCart() {}" }],
          }),
          { status: 200 }
        );
      }
      if (u.includes("anthropic.com")) {
        return anthropicFetch({ text: "В приложении появилась долгожданная корзина товаров! 🛒" })(url, opts);
      }
      return new Response("{}", { status: 404 });
    };

    // При вызове без force срабатывает debounce: пост ещё не создан
    await check(false, testCtx);
    assert.equal(testCtx.get("pending_head"), "c1");
    assert.equal(testCtx.countPosts(), 0);

    // Форсируем проверку (или по истечении debounce)
    await check(true, testCtx);
    assert.equal(testCtx.get("last_sha"), "c1");
    assert.equal(testCtx.countPosts(), 1);

    const posts = testCtx.getPosts({ limit: 1 });
    assert.equal(posts[0].status, "draft");
    assert.ok(posts[0].text.includes("корзина"));
  });

  // 5. Режим auto с отправкой в канал
  it("режим auto: созданный пост автоматически отправляется в канал", async () => {
    testCtx.set("mode", "auto");
    testCtx.set("channel_id", "@testchannel");
    testCtx.set("tg_token", "123:test");
    testCtx.set("last_sha", "c1");

    let tgSent = false;
    let sentChatId = "";
    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("/commits?")) {
        return new Response(
          JSON.stringify([
            { sha: "c2", commit: { message: "feat: темная тема" }, parents: [{ sha: "c1" }] },
            { sha: "c1", commit: { message: "feat: корзина" }, parents: [] },
          ]),
          { status: 200 }
        );
      }
      if (u.includes("/compare/")) {
        return new Response(JSON.stringify({ files: [{ filename: "theme.css", patch: "+body { bg: dark }" }] }), {
          status: 200,
        });
      }
      if (u.includes("anthropic.com")) {
        return anthropicFetch({ text: "Добавлена тёмная тема! 🌙" })(url, opts);
      }
      if (u.includes("telegram.org") && u.includes("sendMessage")) {
        tgSent = true;
        const body = JSON.parse(opts.body);
        sentChatId = body.chat_id;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    await check(true, testCtx);
    assert.equal(tgSent, true);
    assert.equal(sentChatId, "@testchannel");

    const posts = testCtx.getPosts({ limit: 1 });
    assert.equal(posts[0].status, "sent");
  });

  // 6. Ответ SKIP
  it("ответ ИИ SKIP: пост получает статус skipped", async () => {
    testCtx.set("mode", "approve");
    testCtx.set("last_sha", "c2");

    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("/commits?")) {
        return new Response(
          JSON.stringify([
            { sha: "c3", commit: { message: "chore: update deps" }, parents: [{ sha: "c2" }] },
            { sha: "c2", commit: { message: "c2" }, parents: [] },
          ]),
          { status: 200 }
        );
      }
      if (u.includes("/compare/")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (u.includes("anthropic.com")) {
        return anthropicFetch({ text: "SKIP" })(url, opts);
      }
      return new Response("{}", { status: 404 });
    };

    await check(true, testCtx);
    const posts = testCtx.getPosts({ limit: 1 });
    assert.equal(posts[0].status, "skipped");
  });

  // 7. Ошибку Telegram
  it("ошибка Telegram: пост получает статус failed с понятной ошибкой без токена", async () => {
    const { lastInsertRowid } = testCtx.db
      .prepare("insert into posts(head,input,text,status) values(?,?,?,?)")
      .run("head-tg-err", "input", "Текст для отправки", "draft");
    const postId = Number(lastInsertRowid);

    mockFetchHandler = async (url) => {
      const u = String(url);
      if (u.includes("telegram.org")) {
        return new Response(
          JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
          { status: 400 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    await assert.rejects(
      async () => {
        await publish(postId, "Текст для отправки", testCtx);
      },
      /Telegram: Bad Request: chat not found/
    );

    const p = testCtx.post(postId);
    assert.equal(p.status, "failed");
    // Ответ Telegram сохраняется дословно, перед ним — подсказка, что исправить
    assert.match(p.error, /^Telegram не нашёл канал: .*\(Telegram: Bad Request: chat not found\)$/);
  });

  // 8. Двойную публикацию
  it("двойная публикация: второй запрос блокируется атомарным переходом статуса", async () => {
    const { lastInsertRowid } = testCtx.db
      .prepare("insert into posts(head,input,text,status) values(?,?,?,?)")
      .run("head-dbl", "input", "Пост для проверки двойного клика", "draft");
    const postId = Number(lastInsertRowid);

    let sendCount = 0;
    mockFetchHandler = async (url) => {
      const u = String(url);
      if (u.includes("telegram.org")) {
        sendCount++;
        // Небольшая искусственная задержка для имитации сетевого запроса
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const first = publish(postId, "Пост для проверки двойного клика", testCtx);
    const second = publish(postId, "Пост для проверки двойного клика", testCtx);

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /уже отправляется или уже был отправлен/);
    assert.equal(sendCount, 1);
  });

  // 9. Фильтр шума в buildInput
  it("фильтр шума в buildInput: игнорирует package-lock.json, .env и медиафайлы", async () => {
    mockFetchHandler = async (url) => {
      const u = String(url);
      if (u.includes("/compare/")) {
        return new Response(
          JSON.stringify({
            files: [
              { filename: "package-lock.json", additions: 1000, deletions: 500, patch: "@@ lock @@" },
              { filename: ".env.production", additions: 5, deletions: 1, patch: "SECRET=123" },
              { filename: "public/logo.png", additions: 0, deletions: 0 },
              { filename: "bundle.min.js", additions: 10, deletions: 10, patch: "minified" },
              { filename: "src/feature.js", additions: 25, deletions: 2, patch: "+console.log('real code');" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const input = await buildInput("user/repo", "base", "head", ["feat: new cool feature"], "token");

    assert.ok(input.includes("src/feature.js"));
    assert.ok(input.includes("real code"));
    assert.ok(!input.includes("package-lock.json"));
    assert.ok(!input.includes(".env.production"));
    assert.ok(!input.includes("bundle.min.js"));
    assert.ok(!input.includes("logo.png"));
  });

  // 10. Обе ветки провайдера ИИ (Anthropic и OpenAI)
  it("ветка Anthropic: корректно отправляет запрос и парсит ответ", async () => {
    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("anthropic.com")) {
        const body = JSON.parse(opts.body);
        assert.equal(body.model, "claude-3-haiku-20240307");
        assert.equal(opts.headers["x-api-key"], "sk-ant-test");
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "Ответ от Claude" }] }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const text = await ai("входные данные", false, {
      provider: "anthropic",
      key: "sk-ant-test",
      model: "claude-3-haiku-20240307",
    });
    assert.equal(text, "Ответ от Claude");
  });

  it("ветка OpenAI: корректно отправляет запрос и парсит ответ", async () => {
    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("openai.com")) {
        const body = JSON.parse(opts.body);
        assert.equal(body.model, "gpt-4o-mini");
        const authHeader = opts.headers["authorization"] || opts.headers["Authorization"];
        assert.equal(authHeader, "Bearer sk-openai-test");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Ответ от GPT" } }] }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    };

    const text = await ai("входные данные", false, {
      provider: "openai",
      key: "sk-openai-test",
      model: "gpt-4o-mini",
    });
    assert.equal(text, "Ответ от GPT");
  });

  // Дополнительный тест: «Другой вариант» нельзя применять к отправленному посту
  it("сервер запрещает генерацию другого варианта для уже отправленного поста", async () => {
    const cookie = await getAuthCookie();
    const { lastInsertRowid } = testCtx.db
      .prepare("insert into posts(head,input,text,status) values(?,?,?,?)")
      .run("head-sent", "input", "Отправленный пост", "sent");
    const postId = Number(lastInsertRowid);

    const res = await fetch(`${baseUrl}/api/posts/${postId}/regen`, {
      method: "POST",
      headers: { cookie },
    });
    // Конфликт со статусом поста, а не ошибка в запросе
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.match(json.error, /Нельзя изменить уже отправленный пост/);
    assert.equal(json.code, "POST_ALREADY_SENT");
  });

  // Дополнительный тест: GET /health
  it("эндпоинт /health возвращает { ok: true } без авторизации", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { ok: true });
  });

  // Дополнительный тест: Rate limit на /login
  it("rate limiting блокирует вход после 5 неудачных попыток", async () => {
    const testIp = "198.51.100.99";
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": testIp },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      assert.equal(res.status, 401);
    }

    const blockedRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": testIp },
      body: JSON.stringify({ password: TEST_PASS }),
    });
    assert.equal(blockedRes.status, 429);
    const json = await blockedRes.json();
    assert.match(json.error, /Слишком много неудачных попыток/);
  });

  // Дополнительный тест: /logout
  it("маршрут /logout сбрасывает cookie авторизации", async () => {
    const cookie = await getAuthCookie();
    const res = await fetch(`${baseUrl}/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie && setCookie.includes("Max-Age=0"));
  });

  // Дополнительный тест: Проверка GitHub (/api/test/github)
  it("проверка подключения к GitHub возвращает понятный статус", async () => {
    const cookie = await getAuthCookie();
    mockFetchHandler = async (url) => {
      const u = String(url);
      if (u.includes("/repos/")) {
        return new Response(JSON.stringify({ full_name: "developer/project" }), { status: 200 });
      }
      if (u.includes("/user")) {
        return new Response(JSON.stringify({ login: "developer" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const res = await fetch(`${baseUrl}/api/test/github`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.message.includes("developer"));
  });

  // Дополнительный тест: Проверка Telegram (/api/test/telegram)
  it("проверка Telegram проверяет getMe и права бота в канале", async () => {
    const cookie = await getAuthCookie();
    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 777, username: "news_bot" } }), { status: 200 });
      }
      if (u.includes("getChatMember")) {
        return new Response(JSON.stringify({ ok: true, result: { status: "administrator" } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const res = await fetch(`${baseUrl}/api/test/telegram`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.message.includes("@news_bot"));
  });

  // Дополнительный тест: Тестовый пост в канал
  it("отправка тестового поста публикует тестовое сообщение в канал", async () => {
    const cookie = await getAuthCookie();
    let sentText = "";
    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("sendMessage")) {
        const body = JSON.parse(opts.body);
        sentText = body.text;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const res = await fetch(`${baseUrl}/api/test/channel-post`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(sentText.includes("Тестовое сообщение"));
  });

  // Дополнительный тест: Удаление поста и пагинация
  it("удаление поста из истории и пагинация работают корректно", async () => {
    const cookie = await getAuthCookie();
    const { lastInsertRowid } = testCtx.db
      .prepare("insert into posts(head,input,text,status) values(?,?,?,?)")
      .run("head-del", "input", "Пост для удаления", "draft");
    const postId = Number(lastInsertRowid);

    // Пагинация: запрашиваем 1 пост
    const pageRes = await fetch(`${baseUrl}/api/state?limit=1&offset=0`, {
      headers: { cookie },
    });
    const page = await pageRes.json();
    assert.equal(page.pagination.limit, 1);
    assert.equal(page.posts.length, 1);
    assert.ok(page.pagination.total >= 1);

    // Удаление
    const delRes = await fetch(`${baseUrl}/api/posts/${postId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(delRes.status, 200);
    assert.equal(testCtx.post(postId), undefined);
  });

  // Дополнительный тест: Режим ежедневного дайджеста
  it("режим digest собирает коммиты за день в один дайджест", async () => {
    testCtx.set("mode", "digest");
    testCtx.set("last_digest_sha", "c1");
    testCtx.set("last_digest_date", "2000-01-01"); // старая дата, чтобы дайджест сработал

    mockFetchHandler = async (url, opts) => {
      const u = String(url);
      if (u.includes("/commits?")) {
        return new Response(
          JSON.stringify([
            { sha: "c4", commit: { message: "feat: дайджест коммит 2" }, parents: [{ sha: "c3" }] },
            { sha: "c3", commit: { message: "feat: дайджест коммит 1" }, parents: [{ sha: "c1" }] },
            { sha: "c1", commit: { message: "c1" }, parents: [] },
          ]),
          { status: 200 }
        );
      }
      if (u.includes("/compare/")) {
        return new Response(JSON.stringify({ files: [{ filename: "app.js", patch: "+code" }] }), { status: 200 });
      }
      if (u.includes("anthropic.com")) {
        return anthropicFetch({ text: "Главные обновления за день: 1. Дайджест коммит 1. 2. Дайджест коммит 2." })(url, opts);
      }
      return new Response("{}", { status: 404 });
    };

    await check(true, testCtx);
    const posts = testCtx.getPosts({ limit: 1 });
    assert.equal(posts[0].status, "draft");
    assert.ok(posts[0].text.includes("Главные обновления за день"));
  });

  // Дополнительный тест: Пустой ответ ИИ и текст длиннее 4096 символов
  it("пустой ответ ИИ или превышение 4096 символов переводят пост в статус failed", async () => {
    const { lastInsertRowid: idEmpty } = testCtx.db
      .prepare("insert into posts(head,input) values(?,?)")
      .run("head-empty", "input-empty");

    // Пустой ответ на каждом шаге конвейера
    mockFetchHandler = async (url) => {
      return new Response(JSON.stringify({ content: [{ type: "text", text: "   " }] }), { status: 200 });
    };

    await generate(Number(idEmpty), false, testCtx);
    const postEmpty = testCtx.post(Number(idEmpty));
    assert.equal(postEmpty.status, "failed");
    assert.equal(postEmpty.error, "ИИ вернул пустой ответ");

    const { lastInsertRowid: idLong } = testCtx.db
      .prepare("insert into posts(head,input) values(?,?)")
      .run("head-long", "input-long");

    const hugeText = "А".repeat(5000);
    mockFetchHandler = anthropicFetch({ text: hugeText });

    await generate(Number(idLong), false, testCtx);
    const postLong = testCtx.post(Number(idLong));
    assert.equal(postLong.status, "failed");
    assert.ok(postLong.error.includes("4096"));
  });

  // Тест: после смены ENCRYPTION_KEY сервер не падает, а показывает понятное сообщение
  it("после смены ENCRYPTION_KEY сервер не падает, а показывает в панели понятное сообщение 'секреты не удалось расшифровать, введите их заново'", async () => {
    const fs = require("fs");
    const path = require("path");
    const tempDbPath = path.join(__dirname, "temp-key-change.db");

    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

      const oldKey = "original-encryption-key-aaa";
      const newKey = "different-encryption-key-bbb";

      // 1. Создаем базу с первым ключом и сохраняем токен
      const dbOld = createDatabase(tempDbPath, oldKey);
      dbOld.set("github_token", "ghp_valid_secret_123");
      const rawOld = dbOld.getRaw("github_token");
      assert.ok(rawOld.startsWith("enc:v1:"));
      assert.equal(dbOld.get("github_token"), "ghp_valid_secret_123");
      dbOld.db.close();

      // 2. Запускаем базу со ВТОРЫМ (изменившимся) ключом
      const dbNew = createDatabase(tempDbPath, newKey);
      // Сервер не должен падать!
      assert.equal(dbNew.get("github_token"), ""); // расшифровать старым ключом нельзя
      assert.equal(dbNew.isSecretCorrupted("github_token"), true);

      // 3. Создаем приложение с обновленным контекстом
      const appNew = createApp({
        ...dbNew,
        ADMIN_PASSWORD: TEST_PASS,
        SESSION_SECRET: TEST_PASS,
      });

      const tempServer = http.createServer(appNew);
      await new Promise((r) => tempServer.listen(0, r));
      const tempPort = tempServer.address().port;

      try {
        const loginRes = await fetch(`http://127.0.0.1:${tempPort}/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: TEST_PASS }),
        });
        const cookie = loginRes.headers.get("set-cookie").split(";")[0];

        const stateRes = await fetch(`http://127.0.0.1:${tempPort}/api/state`, {
          headers: { cookie },
        });
        assert.equal(stateRes.status, 200);
        const state = await stateRes.json();

        // Проверяем понятное сообщение для пользователя в панели
        assert.equal(state.settings.secrets_corrupted, true);
        assert.equal(state.settings.github_token_corrupted, true);
        assert.equal(state.settings.secrets_message, "секреты не удалось расшифровать, введите их заново");
        assert.equal(state.status.last_error, "секреты не удалось расшифровать, введите их заново");
      } finally {
        await new Promise((r) => tempServer.close(r));
        dbNew.db.close();
      }
    } finally {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      const wal = tempDbPath + "-wal";
      const shm = tempDbPath + "-shm";
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    }
  });

  // 17. Смена пароля администратора через /api/password
  it("смена пароля администратора через /api/password", async () => {
    const cookie = await getAuthCookie();

    // Ошибка: несовпадение паролей
    const mismatchRes = await fetch(`${baseUrl}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        current_password: TEST_PASS,
        new_password: "new-secret-1234",
        confirm_password: "different-password",
      }),
    });
    assert.equal(mismatchRes.status, 400);

    // Ошибка: неверный текущий пароль
    const wrongCurRes = await fetch(`${baseUrl}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        current_password: "wrong-current-password",
        new_password: "new-secret-1234",
        confirm_password: "new-secret-1234",
      }),
    });
    assert.equal(wrongCurRes.status, 401);

    // Успешная смена пароля
    const NEW_PASS = "brand-new-secret-9999";
    const okRes = await fetch(`${baseUrl}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        current_password: TEST_PASS,
        new_password: NEW_PASS,
        confirm_password: NEW_PASS,
      }),
    });
    assert.equal(okRes.status, 200);

    // Проверяем вход со старым паролем -> 401
    const oldLogin = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASS }),
    });
    assert.equal(oldLogin.status, 401);

    // Проверяем вход с новым паролем -> 200
    const newLogin = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: NEW_PASS }),
    });
    assert.equal(newLogin.status, 200);

    // Возвращаем пароль назад для последующих тестов
    const newCookie = newLogin.headers.get("set-cookie").split(";")[0];
    await fetch(`${baseUrl}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: newCookie },
      body: JSON.stringify({
        current_password: NEW_PASS,
        new_password: TEST_PASS,
        confirm_password: TEST_PASS,
      }),
    });
  });

  // 18. Удаление сообщения из канала через deleteMessage
  it("удаление сообщения из канала через /api/posts/:id/delete-from-channel", async () => {
    const cookie = await getAuthCookie();

    // Создаем отправленный пост с tg_message_id
    const stmt = testCtx.db.prepare("INSERT INTO posts (status, text, tg_message_id, sent_at) VALUES ('sent', 'Пост для удаления', 777, datetime('now'))");
    const info = stmt.run();
    const postId = info.lastInsertRowid;

    let deleteMessageCalled = false;
    mockFetchHandler = async (url, opts) => {
      if (String(url).includes("deleteMessage")) {
        deleteMessageCalled = true;
        const body = JSON.parse(opts.body);
        assert.equal(body.message_id, 777);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: true }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const res = await fetch(`${baseUrl}/api/posts/${postId}/delete-from-channel`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.equal(deleteMessageCalled, true);

    const postAfter = testCtx.post(postId);
    assert.equal(postAfter.tg_message_id, null);
  });

  // 19. Сброс владельца Telegram-бота
  it("сброс владельца Telegram-бота через /api/test/reset-owner", async () => {
    const cookie = await getAuthCookie();
    testCtx.set("tg_owner_chat_id", "999888");
    testCtx.set("tg_owner_username", "@someuser");

    const res = await fetch(`${baseUrl}/api/test/reset-owner`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);

    assert.equal(testCtx.get("tg_owner_chat_id"), "");
    assert.equal(testCtx.get("tg_owner_username"), "");
  });

  // 20. Фильтрация и счётчики в /api/state
  it("фильтрация постов и подсчёт категорий в /api/state", async () => {
    const cookie = await getAuthCookie();

    testCtx.db.prepare("DELETE FROM posts").run();
    testCtx.db.prepare("INSERT INTO posts (status, text) VALUES ('draft', 'Черновик 1')").run();
    testCtx.db.prepare("INSERT INTO posts (status, text) VALUES ('draft', 'Черновик 2')").run();
    testCtx.db.prepare("INSERT INTO posts (status, text) VALUES ('sent', 'Отправленный 1')").run();
    testCtx.db.prepare("INSERT INTO posts (status, text) VALUES ('failed', 'Ошибка 1')").run();
    testCtx.db.prepare("INSERT INTO posts (status, text) VALUES ('skipped', 'Пропущен 1')").run();

    const res = await fetch(`${baseUrl}/api/state?filter=draft`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.counts.total, 5);
    assert.equal(data.counts.draft, 2);
    assert.equal(data.counts.sent, 1);
    assert.equal(data.counts.failed, 1);
    assert.equal(data.counts.skipped, 1);

    // Только черновики вернулись в posts
    assert.equal(data.posts.length, 2);
    assert.ok(data.posts.every((p) => p.status === "draft"));
  });
});
