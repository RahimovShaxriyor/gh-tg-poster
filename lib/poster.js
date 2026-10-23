const { cleanError } = require("./crypto");
const { tg, ai, buildInput } = require("./services");

/**
 * Отправка поста в Telegram с атомарным обновлением статуса, защищающим от двойной публикации.
 */
async function publish(id, text, ctx) {
  const p = ctx.post(id);
  if (!p) throw new Error("Пост не найден");

  const postText = String(text ?? p.text ?? "").trim();
  if (!postText) throw new Error("Текст поста не может быть пустым");
  if (postText.length > 4096) throw new Error("Текст поста длиннее 4096 символов: сократите перед отправкой");

  const ch = ctx.get("channel_id");
  if (!ch) throw new Error("Канал не подключён: добавь бота админом в канал или впиши @канал");

  // Атомарный переход статуса: только если пост был в черновиках или ошибке
  const stmt = ctx.db.prepare("update posts set status='sending', text=? where id=? and status in ('draft','failed')");
  const info = stmt.run(postText, id);
  if (info.changes === 0) {
    throw new Error("Пост уже отправляется или уже был отправлен");
  }

  try {
    const r = await ctx.tg("sendMessage", { chat_id: ch, text: postText }, ctx.get("tg_token"));
    if (!r.ok) {
      const errMsg = cleanError(r.description || "Неизвестная ошибка Telegram");
      ctx.db.prepare("update posts set status='failed', error=? where id=?").run(errMsg, id);
      throw new Error("Telegram: " + errMsg);
    }
    const msgId = r.result?.message_id || null;
    const now = new Date().toISOString();
    ctx.db.prepare("update posts set status='sent', error=null, interrupted=0, tg_message_id=?, sent_at=? where id=?").run(msgId, now, id);
  } catch (err) {
    const errMsg = cleanError(err.message);
    ctx.db.prepare("update posts set status='failed', error=? where id=?").run(errMsg, id);
    throw err;
  }
}

/**
 * Генерация текста поста с помощью ИИ.
 * autoPublish=true передаёт только check() в режиме auto. Ручная перегенерация
 * («Другой вариант», «Всё равно написать») всегда оставляет пост черновиком.
 */
async function generate(id, force = false, ctx, isDigest = false, { autoPublish = false } = {}) {
  const p = ctx.post(id);
  if (!p) return;

  if (p.status === "sent") {
    throw new Error("Нельзя изменить уже отправленный пост");
  }
  if (p.status === "sending") {
    throw new Error("Пост сейчас отправляется");
  }

  try {
    const provider = ctx.get("ai_provider", "anthropic");
    const key = ctx.get("ai_key");
    const model = ctx.get("ai_model");
    const tone = ctx.get("tone");

    const text = await ctx.ai(p.input, force, { provider, key, model, tone, isDigest });
    if (text === "SKIP") {
      ctx.db.prepare("update posts set status='skipped', error=null where id=?").run(id);
      return;
    }

    const trimmed = (text || "").trim();
    if (!trimmed) {
      ctx.db.prepare("update posts set status='failed', error=? where id=?").run("ИИ вернул пустой ответ", id);
      return;
    }

    if (trimmed.length > 4096) {
      ctx.db.prepare("update posts set text=?, status='failed', error=? where id=?").run(
        trimmed,
        "Текст от ИИ превысил 4096 символов (ограничение Telegram)",
        id
      );
      return;
    }

    ctx.db.prepare("update posts set text=?, status='draft', error=null where id=?").run(trimmed, id);

    if (autoPublish) {
      await publish(id, trimmed, ctx);
      return;
    }

    // Уведомление владельца о черновике (если включено)
    try {
      const ownerChatId = ctx.get("tg_owner_chat_id");
      const token = ctx.get("tg_token");
      if (ownerChatId && token && ctx.get("tg_notify_drafts") === "1") {
        const domain = process.env.DOMAIN || ctx.get("domain") || "localhost:3000";
        const panelUrl = domain.startsWith("http") ? domain : "https://" + domain;
        const snippet = trimmed.slice(0, 300) + (trimmed.length > 300 ? "..." : "");
        const msgText = `📝 Новый черновик поста (#${id}):\n\n${snippet}\n\n🔗 Панель: ${panelUrl}`;
        const reply_markup = {
          inline_keyboard: [
            [
              { text: "✅ Опубликовать", callback_data: `pub:${id}` },
              { text: "❌ Отклонить", callback_data: `rej:${id}` },
            ],
          ],
        };
        await ctx.tg("sendMessage", { chat_id: ownerChatId, text: msgText, reply_markup }, token);
      }
    } catch (err) {
      console.warn("Не удалось отправить уведомление о черновике владельцу:", cleanError(err.message));
    }
  } catch (err) {
    const errMsg = cleanError(err.message || "Ошибка генерации");
    ctx.db.prepare("update posts set status='failed', error=? where id=?").run(errMsg, id);
  }
}

let busy = false;

/**
 * Проверка новых коммитов в GitHub репозитории.
 */
async function check(force = false, ctx) {
  const repo = ctx.get("repo");
  const branch = ctx.get("branch", "main");
  const instId = ctx.get("github_installation_id");
  const token = ctx.get("github_token");

  if (busy || !repo || (!token && !instId)) return;
  busy = true;

  try {
    ctx.set("last_check", new Date().toISOString());

    const r = await ctx.gh(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`, token, ctx);
    if (!r.ok) {
      if (r.status === 401 || r.status === 404) {
        throw new Error("GitHub вернул " + r.status + " (доступ отозван, проверьте подключение в настройках)");
      }
      throw new Error("GitHub вернул " + r.status + " (проверь токен и репозиторий)");
    }

    const commits = await r.json();
    if (!Array.isArray(commits)) {
      throw new Error("GitHub вернул неожиданный ответ: " + cleanError(JSON.stringify(commits).slice(0, 100)));
    }

    ctx.set("last_error", "");
    if (!commits.length) return;

    const head = commits[0].sha;
    const last = ctx.get("last_sha");

    // Первый запуск: только запоминаем последний коммит, старые не постим
    if (!last) {
      ctx.set("last_sha", head);
      ctx.set("pending_head", "");
      ctx.set("pending_at", "");
      return;
    }

    const mode = ctx.get("mode", "approve");

    // Режим ежедневного дайджеста
    if (mode === "digest") {
      const digestTime = ctx.get("digest_time", "18:00");
      const digestTz = ctx.get("digest_tz", "Europe/Moscow");

      let nowParts;
      try {
        const formatter = new Intl.DateTimeFormat("ru-RU", {
          timeZone: digestTz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
        nowParts = formatter.formatToParts(new Date()).reduce((acc, p) => {
          acc[p.type] = p.value;
          return acc;
        }, {});
      } catch {
        // Fallback на UTC при неверном названии таймзоны
        const d = new Date();
        nowParts = {
          year: String(d.getUTCFullYear()),
          month: String(d.getUTCMonth() + 1).padStart(2, "0"),
          day: String(d.getUTCDate()).padStart(2, "0"),
          hour: String(d.getUTCHours()).padStart(2, "0"),
          minute: String(d.getUTCMinutes()).padStart(2, "0"),
        };
      }

      const todayStr = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
      const currentHHMM = `${nowParts.hour}:${nowParts.minute}`;
      const lastDigestDate = ctx.get("last_digest_date");

      if (force || (currentHHMM >= digestTime && lastDigestDate !== todayStr)) {
        const baseSha = ctx.get("last_digest_sha") || last;
        const idx = commits.findIndex((c) => c.sha === baseSha);
        const fresh = idx === -1 ? commits : commits.slice(0, idx);
        const real = fresh.filter((c) => c.parents.length < 2);
        const msgs = (real.length ? real : fresh).map((c) => c.commit.message);

        ctx.set("last_digest_date", todayStr);
        ctx.set("last_digest_sha", head);
        ctx.set("last_sha", head);

        if (msgs.length > 0) {
          const input = await ctx.buildInput(repo, baseSha, head, msgs, token, ctx);
          const { lastInsertRowid } = ctx.db.prepare("insert into posts(head,input,kind) values(?,?,'digest')").run(head, input);
          await generate(Number(lastInsertRowid), false, ctx, true);
        }
      }
      return;
    }

    // Обычные режимы (approve / auto) с debounce
    if (head === last) {
      ctx.set("pending_head", "");
      ctx.set("pending_at", "");
      return;
    }

    if (ctx.get("pending_head") !== head) {
      ctx.set("pending_head", head);
      ctx.set("pending_at", Date.now());
    }

    // Debounce: ждём паузы между коммитами
    const debounceMinutes = Math.max(0, Number(ctx.get("debounce", "10")) || 0);
    const pendingAt = Number(ctx.get("pending_at", "0")) || 0;
    if (!force && Date.now() - pendingAt < debounceMinutes * 60000) {
      return;
    }

    const idx = commits.findIndex((c) => c.sha === last);
    const fresh = idx === -1 ? commits : commits.slice(0, idx);
    const real = fresh.filter((c) => c.parents.length < 2);
    const msgs = (real.length ? real : fresh).map((c) => c.commit.message);

    ctx.set("last_sha", head);
    ctx.set("pending_head", "");
    ctx.set("pending_at", "");

    if (!msgs.length) return;

    const input = await ctx.buildInput(repo, last, head, msgs, token, ctx);
    const { lastInsertRowid } = ctx.db.prepare("insert into posts(head,input) values(?,?)").run(head, input);
    await generate(Number(lastInsertRowid), false, ctx, false, { autoPublish: mode === "auto" });
  } catch (err) {
    ctx.set("last_error", cleanError(err.message));
  } finally {
    busy = false;
  }
}

/**
 * Получение состояния проверки и debounce для веб-интерфейса.
 */
function getStatus(ctx) {
  const lastCheck = ctx.get("last_check");
  const lastError = ctx.get("last_error");
  const pendingHead = ctx.get("pending_head");
  const pendingAt = Number(ctx.get("pending_at", "0")) || 0;
  const debounce = Math.max(0, Number(ctx.get("debounce", "10")) || 0);

  let minutesLeft = 0;
  if (pendingHead && pendingAt) {
    const elapsed = Date.now() - pendingAt;
    const remainingMs = Math.max(0, debounce * 60000 - elapsed);
    minutesLeft = Math.ceil(remainingMs / 60000);
  }

  return {
    last_check: lastCheck,
    last_error: lastError,
    pending_head: pendingHead,
    pending_at: pendingAt || null,
    debounce,
    minutes_left: minutesLeft,
  };
}

module.exports = {
  publish,
  generate,
  check,
  getStatus,
};
