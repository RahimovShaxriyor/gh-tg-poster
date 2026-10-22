const { cleanError } = require("./crypto");

const { installationToken } = require("./github-app");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gh = async (path, tokenOrCtx, maybeCtx) => {
  let token = typeof tokenOrCtx === "string" ? tokenOrCtx : null;
  let ctx = typeof tokenOrCtx === "object" && tokenOrCtx !== null ? tokenOrCtx : maybeCtx;
  let installationId = null;

  if (!token && ctx?.get) {
    installationId = ctx.get("github_installation_id");
    if (installationId) {
      token = await installationToken(installationId, false, {
        appId: ctx.GITHUB_APP_ID || process.env.GITHUB_APP_ID,
        privateKey: ctx.GITHUB_APP_PRIVATE_KEY || ctx.GITHUB_APP_PRIVATE_KEY_B64 || ctx.GITHUB_APP_PRIVATE_KEY_PATH || undefined,
        fetch: global.fetch,
      });
    } else {
      token = ctx.get("github_token");
    }
  }

  const makeReq = (t) =>
    fetch("https://api.github.com" + path, {
      headers: {
        Authorization: t ? `Bearer ${t}` : "",
        Accept: "application/vnd.github+json",
        "User-Agent": "gh-tg-web",
      },
    });

  let res = await makeReq(token);

  // При 401, если это была установка GitHub App, перевыпускаем токен и повторяем
  const instId = installationId || (ctx?.get && ctx.get("github_installation_id"));
  if (res.status === 401 && instId) {
    try {
      token = await installationToken(instId, true, {
        appId: ctx?.GITHUB_APP_ID || process.env.GITHUB_APP_ID,
        privateKey: ctx?.GITHUB_APP_PRIVATE_KEY || ctx?.GITHUB_APP_PRIVATE_KEY_B64 || ctx?.GITHUB_APP_PRIVATE_KEY_PATH || undefined,
        fetch: global.fetch,
      });
      res = await makeReq(token);
    } catch {}
  }

  return res;
};

const tg = async (method, body, token) => {
  if (!token) throw new Error("Токен Telegram-бота не задан");
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return json;
  } catch (err) {
    throw new Error("Ошибка сети Telegram: " + cleanError(err.message));
  }
};

const deleteWebhook = async (token) => {
  if (!token) return { ok: false };
  try {
    return await tg("deleteWebhook", { drop_pending_updates: false }, token);
  } catch (err) {
    console.error("Ошибка при удалении webhook Telegram:", cleanError(err.message));
    return { ok: false, description: cleanError(err.message) };
  }
};

const SYSTEM = (tone) => `Ты ведёшь Telegram-канал о проекте автора. По списку изменений напиши короткий анонс для подписчиков (до 800 символов).
Пиши по-человечески и по-русски, без технического жаргона, делай акцент на том, что изменилось для пользователя. Можно 1-3 уместных эмодзи.
Опирайся только на данные ниже, ничего не выдумывай.
Если изменения чисто технические (рефакторинг, зависимости, опечатки, CI) и подписчикам это неинтересно, верни ровно одно слово: SKIP.
Верни только текст поста, без пояснений.${tone ? "\nПожелания автора к стилю: " + tone : ""}`;

const SYSTEM_DIGEST = (tone) => `Ты ведёшь Telegram-канал о проекте автора. На основе списка изменений за прошедший день составь краткий и живой дайджест для подписчиков (до 1000 символов).
Пиши по-человечески и по-русски, без сложного технического жаргона, с акцентом на пользу и новые возможности для пользователя. Можно 2-4 уместных эмодзи.
Если за день не произошло ничего значимого для аудитории (только мелкие технические правки или CI), верни ровно одно слово: SKIP.
Верни только готовый текст дайджеста без лишних вступлений.${tone ? "\nПожелания автора к стилю: " + tone : ""}`;

async function ai(input, force, { provider = "anthropic", key, model, tone, isDigest = false } = {}) {
  if (!key || !model) throw new Error("Заполни ключ и модель ИИ в настройках");
  const sysPrompt = isDigest ? SYSTEM_DIGEST(tone) : SYSTEM(tone);
  const userPrompt = force
    ? input + "\n\nНапиши пост в любом случае, не отвечай SKIP."
    : input;

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error("OpenAI: " + (j.error?.message || res.status));
    const content = (j.choices?.[0]?.message?.content || "").trim();
    return content;
  }

  // Anthropic
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: sysPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Anthropic: " + (j.error?.message || res.status));
  const textBlock = (j.content || []).find((b) => b.type === "text");
  return (textBlock?.text || "").trim();
}

const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.env.*)$|\.(min\.js|map|png|jpe?g|gif|svg|ico|woff2?|lock)$/i;

async function buildInput(repo, base, head, msgs, token, ctx) {
  let out = "Коммиты:\n" + msgs.map((m) => "- " + m.split("\n")[0]).join("\n");
  try {
    const r = await gh(`/repos/${repo}/compare/${base}...${head}`, token, ctx);
    if (r.ok) {
      const data = await r.json();
      const files = (data.files ?? []).filter((f) => !NOISE.test(f.filename));
      out += "\n\nФайлы:\n" + files.map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
      let budget = 6000;
      for (const f of files) {
        if (!f.patch || budget <= 0) continue;
        const chunk = f.patch.slice(0, Math.min(1500, budget));
        budget -= chunk.length;
        out += `\n\n--- ${f.filename}\n${chunk}`;
      }
    }
  } catch (err) {
    console.warn("Не удалось получить compare diff из GitHub:", cleanError(err.message));
  }
  return out;
}

module.exports = {
  sleep,
  gh,
  tg,
  deleteWebhook,
  ai,
  NOISE,
  buildInput,
  SYSTEM,
  SYSTEM_DIGEST,
};
