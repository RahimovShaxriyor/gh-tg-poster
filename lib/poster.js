const { cleanError } = require("./crypto");
const { notifyOwner, sendDraftToOwner, botToken } = require("./notify");
const { runPipeline, isSkip, announcedFromMeta } = require("./pipeline");
const services = require("./services");

// Незавершённые операции (проверка, генерация, отправка): при остановке сервера их дожидаемся
const inflight = new Set();
function track(promise) {
  inflight.add(promise);
  promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
  return promise;
}

/**
 * Ожидание завершения текущих операций, но не дольше timeoutMs.
 * Возвращает true, если всё завершилось вовремя.
 */
async function waitIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (inflight.size && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
  }
  return inflight.size === 0;
}

/**
 * Отправка поста в Telegram с атомарным обновлением статуса, защищающим от двойной публикации.
 */
function publish(id, text, ctx) {
  return track(doPublish(id, text, ctx));
}

async function doPublish(id, text, ctx) {
  const p = ctx.post(id);
  if (!p) throw new Error("Пост не найден");

  const postText = String(text ?? p.text ?? "").trim();
  if (!postText) throw new Error("Текст поста не может быть пустым");
  if (postText.length > 4096) throw new Error("Текст поста длиннее 4096 символов: сократите перед отправкой");

  const ch = ctx.get("channel_id");
  if (!ch) throw new Error("Канал не подключён: добавь бота админом в канал или впиши @канал");
  // Без бота пост не трогаем: иначе он ушёл бы в «отправка прервалась»
  const token = botToken(ctx);
  if (!token) throw new Error("Бот не настроен: задайте TG_BOT_TOKEN в .env и перезапустите сервер");

  // Атомарный переход статуса: только если пост был в черновиках или ошибке
  const info = ctx.db
    .prepare("update posts set status='sending', text=? where id=? and status in ('draft','failed')")
    .run(postText, id);
  if (info.changes === 0) {
    throw new Error("Пост уже отправляется или уже был отправлен");
  }

  let r;
  try {
    r = await ctx.tg("sendMessage", { chat_id: ch, text: postText }, token);
  } catch (err) {
    // Таймаут или обрыв сети: Telegram мог успеть принять сообщение, поэтому это «прервано»
    const errMsg = cleanError(err.message) + ". Сообщение могло дойти до канала: проверьте канал, прежде чем отправлять снова.";
    ctx.db.prepare("update posts set status='failed', interrupted=1, error=? where id=?").run(errMsg, id);
    throw new Error(errMsg);
  }

  if (!r?.ok) {
    const errMsg = "Telegram: " + cleanError(r?.description || "неизвестная ошибка");
    ctx.db.prepare("update posts set status='failed', interrupted=0, error=? where id=?").run(errMsg, id);
    throw new Error(errMsg);
  }

  const msgId = r.result?.message_id || null;
  ctx.db
    .prepare("update posts set status='sent', error=null, interrupted=0, tg_message_id=?, sent_at=? where id=?")
    .run(msgId, new Date().toISOString(), id);
  recordAnnounced(id, ctx);
}

/**
 * Журнал объявленного: пункты из фактов поста, который стал sent. Ошибка журнала публикацию не отменяет.
 */
function recordAnnounced(id, ctx) {
  if (typeof ctx.addAnnounced !== "function") return;
  try {
    const p = ctx.post(id);
    if (p?.status !== "sent" || ctx.announcedForPost(id)) return;
    const items = announcedFromMeta(parseJsonColumn(p.meta));
    if (items.length) ctx.addAnnounced(id, items);
  } catch (err) {
    console.warn("Не удалось записать пост в журнал объявленного:", cleanError(err.message));
  }
}

/**
 * Генерация текста поста с помощью ИИ.
 * Пост на время генерации переводится в статус generating. Пока он в этом статусе, его нельзя
 * ни отправить, ни запустить генерацию повторно, а результат записывается только в пост,
 * который всё ещё в generating. Так ответ ИИ не может «оживить» уже отправленный пост.
 *
 * Возвращает { status: 'draft' | 'skipped' | 'failed', error? }.
 * autoPublish=true передаёт только check() в режиме auto. Ручная перегенерация
 * («Другой вариант», «Всё равно написать») всегда оставляет пост черновиком.
 */
function generate(id, force = false, ctx, isDigest = false, opts = {}) {
  return track(doGenerate(id, force, ctx, isDigest, opts));
}

const parseJsonColumn = (v) => {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/**
 * Профиль канала из настроек (раздел «Канал и стиль»). Ссылка для призыва — страница репозитория.
 */
function profileFromSettings(ctx) {
  const repo = ctx.get("repo");
  return {
    audience: ctx.get("audience", "mixed"),
    voice: ctx.get("voice"),
    tone: ctx.get("tone"),
    samples: ctx.get("style_samples"),
    banned: ctx.get("banned_words"),
    emoji: ctx.get("emoji", "few"),
    cta: ctx.get("cta", "none"),
    link: repo ? `https://github.com/${repo}` : "",
  };
}

/**
 * Вход конвейера: структура из input_data (или список коммитов старого поста) и пояснения автора.
 */
function pipelineData(p) {
  const data = parseJsonColumn(p.input_data);
  const notes = parseJsonColumn(p.notes);
  if (!data && !notes) return null;
  const base = data || {
    commits: (parseJsonColumn(p.commits) || []).map((c) => ({ sha: c.sha, message: c.message || "" })),
    files: null,
  };
  return { ...base, notes: notes || {} };
}

async function doGenerate(id, force, ctx, isDigest, { autoPublish = false, locked = false, notify = true } = {}) {
  const p = ctx.post(id);
  if (!p) throw new Error("Пост не найден");

  if (!locked) {
    const lock = ctx.db
      .prepare("update posts set status='generating', error=null where id=? and status in ('draft','failed','skipped','rejected')")
      .run(id);
    if (lock.changes === 0) {
      const now = ctx.post(id);
      if (now?.status === "sent") throw new Error("Нельзя изменить уже отправленный пост");
      if (now?.status === "sending") throw new Error("Пост сейчас отправляется");
      if (now?.status === "generating") throw new Error("Новый вариант уже готовится");
      throw new Error("Этот пост сейчас нельзя изменить");
    }
  }

  // Все записи результата — только в пост, который всё ещё в generating
  const finish = (sql, ...args) => ctx.db.prepare(sql + " where id=? and status='generating'").run(...args, id);

  const provider = ctx.get("ai_provider", "anthropic");
  const key = ctx.get("ai_key");
  const model = ctx.get("ai_model");
  const verifyModel = ctx.get("verify_model", "") || model;
  const aiCall = ctx.aiCall || services.aiCall;
  // Проверка может идти более дешёвой моделью (настройка «Модель для проверки»)
  const call = (req) => aiCall({ ...req, provider, key, model: req.step === "verify" ? verifyModel : model });

  let r;
  try {
    r = await runPipeline({
      data: pipelineData(p),
      input: p.input || "",
      force,
      isDigest,
      strict: ctx.get("strict_check", "1") !== "0",
      profile: profileFromSettings(ctx),
      // Память канала: журнал объявленного за выбранную глубину и последние отправленные посты
      announced: typeof ctx.getAnnounced === "function" ? ctx.getAnnounced(ctx.get("journal_days", "90")) : [],
      recent: typeof ctx.recentSentTexts === "function" ? ctx.recentSentTexts(3) : [],
      call,
    });
  } catch (err) {
    r = { status: "failed", error: err.message || "Ошибка генерации", meta: null };
  }

  const meta = r.meta ? JSON.stringify(r.meta) : null;
  if (r.status === "skipped") {
    finish("update posts set status='skipped', error=null, meta=?, needs_review=0", meta);
    return { status: "skipped" };
  }
  if (r.status === "failed") {
    const error = cleanError(r.error || "Ошибка генерации");
    if (r.text) finish("update posts set text=?, status='failed', error=?, meta=?, needs_review=?", r.text, error, meta, r.needsReview ? 1 : 0);
    else finish("update posts set status='failed', error=?, meta=?", error, meta);
    return { status: "failed", error };
  }

  const trimmed = r.text;
  const saved = finish("update posts set text=?, status='draft', error=null, interrupted=0, meta=?, needs_review=?", trimmed, meta, r.needsReview ? 1 : 0);
  if (!saved.changes) return { status: ctx.post(id)?.status || "failed" };

  // Текст с непроверенными утверждениями сам не публикуется даже в режиме auto: остаётся черновиком
  if (autoPublish && r.needsReview) autoPublish = false;

  if (autoPublish) {
    try {
      await publish(id, trimmed, ctx);
    } catch (err) {
      return { status: "failed", error: cleanError(err.message) };
    }
    return { status: "sent" };
  }

  if (notify && ctx.get("tg_notify_drafts") === "1") {
    await sendDraftToOwner(ctx, id);
  }
  return { status: "draft" };
}

/**
 * Новые коммиты после base. Если base нет среди последних коммитов (force-push, rebase или
 * больше 30 новых коммитов), список берётся из compare: GitHub отдаёт ровно те коммиты head,
 * которых нет в base. Если base уже не существует, берётся только верхний коммит.
 */
async function collectFresh(repo, base, commits, token, ctx) {
  const idx = commits.findIndex((c) => c.sha === base);
  if (idx !== -1) return { fresh: commits.slice(0, idx), rewritten: false };

  try {
    const r = await ctx.gh(`/repos/${repo}/compare/${base}...${commits[0].sha}`, token, ctx);
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data.commits) ? [...data.commits].reverse() : [];
      return { fresh: list, rewritten: data.status === "diverged" || data.status === "behind" };
    }
  } catch (err) {
    console.warn("Не удалось сравнить коммиты:", cleanError(err.message));
  }
  return { fresh: commits.slice(0, 1), rewritten: true };
}

const commitSummary = (c) => ({
  sha: c.sha,
  message: String(c.commit?.message || "").split("\n")[0],
  date: c.commit?.committer?.date || c.commit?.author?.date || null,
});

function messagesOf(fresh) {
  const real = fresh.filter((c) => (c.parents?.length || 0) < 2);
  return real.length ? real : fresh;
}

function githubErrorMessage(r) {
  const remaining = r.headers?.get?.("x-ratelimit-remaining");
  if ((r.status === 403 || r.status === 429) && remaining === "0") {
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
    const when = reset ? new Date(reset).toISOString().slice(11, 16) + " UTC" : "через час";
    return `Исчерпан лимит запросов GitHub, проверка возобновится после ${when}`;
  }
  if (r.status === 401) return "GitHub вернул 401: токен недействителен или доступ отозван, подключите GitHub заново";
  if (r.status === 404) return "GitHub вернул 404: репозиторий или ветка не найдены, либо к ним нет доступа";
  return "GitHub вернул " + r.status + " (проверь токен и репозиторий)";
}

const REWRITTEN_NOTE = "История ветки переписана (force-push): проверьте, что пост не повторяет старые новости";

let busy = false;

/**
 * Проверка новых коммитов в GitHub репозитории.
 * Возвращает итог для панели и бота:
 *   { status: 'busy' | 'not_configured' | 'first_run' | 'no_new' | 'waiting' | 'created' | 'error',
 *     posts: [{ id, status, error }], latest: { sha, message, date }, error }
 * silent=true: ничего не писать владельцу (итог сообщает вызывающий, например команда /check в боте).
 */
function check(force = false, ctx, { silent = false } = {}) {
  if (busy) return Promise.resolve({ status: "busy", posts: [] });
  return track(doCheck(force, ctx, silent));
}

async function doCheck(force, ctx, silent) {
  const repo = ctx.get("repo");
  const branch = ctx.get("branch", "main");
  const instId = ctx.get("github_installation_id");
  const token = ctx.get("github_token");

  if (!repo || (!token && !instId)) return { status: "not_configured", posts: [] };
  busy = true;

  const result = { status: "no_new", posts: [], latest: null };
  const prevError = ctx.get("last_error");
  // Настройки могли поменять, пока шёл запрос: тогда результат этой проверки выбрасываем
  const sameTarget = () => ctx.get("repo") === repo && ctx.get("branch", "main") === branch;

  try {
    ctx.set("last_check", new Date().toISOString());

    const r = await ctx.gh(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`, token, ctx);
    if (!r.ok) throw new Error(githubErrorMessage(r));

    const commits = await r.json();
    if (!Array.isArray(commits)) {
      throw new Error("GitHub вернул неожиданный ответ: " + cleanError(JSON.stringify(commits).slice(0, 100)));
    }

    ctx.set("last_error", "");
    if (!commits.length) return result;
    result.latest = commitSummary(commits[0]);
    if (!sameTarget()) return result;

    const head = commits[0].sha;
    const last = ctx.get("last_sha");

    // Первый запуск: только запоминаем последний коммит, старые не постим
    if (!last) {
      ctx.set("last_sha", head);
      ctx.set("pending_head", "");
      ctx.set("pending_at", "");
      result.status = "first_run";
      return result;
    }

    const mode = ctx.get("mode", "approve");
    const isDigest = mode === "digest";

    if (isDigest) {
      const today = zonedNow(ctx.get("digest_tz", "Europe/Moscow"));
      const due = today.hhmm >= ctx.get("digest_time", "18:00") && ctx.get("last_digest_date") !== today.date;
      if (!force && !due) return result;
      if (head === last) {
        ctx.set("last_digest_date", today.date);
        return result;
      }
    } else {
      if (head === last) {
        ctx.set("pending_head", "");
        ctx.set("pending_at", "");
        return result;
      }
      if (ctx.get("pending_head") !== head) {
        ctx.set("pending_head", head);
        ctx.set("pending_at", Date.now());
      }
      // Debounce: ждём паузы между коммитами
      const debounceMinutes = Math.max(0, Number(ctx.get("debounce", "10")) || 0);
      const pendingAt = Number(ctx.get("pending_at", "0")) || 0;
      if (!force && Date.now() - pendingAt < debounceMinutes * 60000) {
        result.status = "waiting";
        return result;
      }
    }

    const collected = await collectFresh(repo, last, commits, token, ctx);
    const rewritten = collected.rewritten;
    // Коммиты, уже вошедшие в отправленные посты, повторно не берём (например, после force-push)
    const already = typeof ctx.sentShas === "function" ? ctx.sentShas(collected.fresh.map((c) => c.sha)) : new Set();
    const fresh = collected.fresh.filter((c) => !already.has(String(c.sha).toLowerCase()));
    const picked = messagesOf(fresh);
    // Вход для ИИ: текст (для показа и старого пути) и, если доступно, файлы с diff для конвейера
    let input = "";
    let inputData = null;
    if (picked.length) {
      const msgs = picked.map((c) => c.commit.message);
      if (typeof ctx.buildInputData === "function") {
        const built = await ctx.buildInputData(repo, last, head, msgs, token, ctx);
        input = built.text;
        inputData = { commits: picked.map((c) => ({ sha: c.sha, message: String(c.commit?.message || "") })), files: built.files };
      } else {
        input = await ctx.buildInput(repo, last, head, msgs, token, ctx);
        inputData = { commits: picked.map((c) => ({ sha: c.sha, message: String(c.commit?.message || "") })), files: null };
      }
    }

    // last_sha сдвигается в одной транзакции с созданием поста: при сбое до этой точки
    // коммиты не теряются, а будут взяты следующей проверкой
    const kind = isDigest ? "digest" : "commit";
    const postId = ctx.db.transaction(() => {
      if (!sameTarget() || ctx.get("last_sha") !== last) return null;
      ctx.set("last_sha", head);
      ctx.set("pending_head", "");
      ctx.set("pending_at", "");
      if (isDigest) ctx.set("last_digest_date", zonedNow(ctx.get("digest_tz", "Europe/Moscow")).date);
      if (!picked.length) return null;
      const info = ctx.db
        .prepare("insert into posts(head,input,input_data,kind,commits,status) values(?,?,?,?,?,'generating')")
        .run(head, input, JSON.stringify(inputData), kind, JSON.stringify(picked.map(commitSummary)));
      // Все коммиты поста, включая merge: для бейджей на вкладке «Коммиты» и защиты от дублей
      if (typeof ctx.recordPostCommits === "function") ctx.recordPostCommits(Number(info.lastInsertRowid), fresh.map((c) => c.sha));
      return Number(info.lastInsertRowid);
    })();

    if (!postId) return result;

    // После переписанной истории не публикуем сами даже в auto: только черновик с пометкой
    const gen = await generate(postId, false, ctx, isDigest, {
      locked: true,
      autoPublish: mode === "auto" && !rewritten,
      notify: !silent,
    });
    if (rewritten && ctx.post(postId)?.status === "draft") {
      ctx.db.prepare("update posts set error=? where id=?").run(REWRITTEN_NOTE, postId);
    }
    if (gen.status === "failed" && !silent) {
      await notifyOwner(ctx, `Не удалось подготовить пост #${postId}: ${gen.error}`);
    }
    result.status = "created";
    result.posts.push({ id: postId, status: ctx.post(postId)?.status, error: gen.error });
    return result;
  } catch (err) {
    const error = cleanError(err.message);
    ctx.set("last_error", error);
    // Владельцу пишем только о новой ошибке, а не на каждой проверке
    if (error !== prevError && !silent) await notifyOwner(ctx, `Проверка GitHub не удалась: ${error}`);
    return { status: "error", posts: [], latest: result.latest, error };
  } finally {
    busy = false;
  }
}

/**
 * Текущие дата и время в часовом поясе tz (IANA). При неверном поясе — UTC.
 */
function zonedNow(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date()).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  } catch {
    const iso = new Date().toISOString();
    return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
}

const isBusy = () => busy;

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
    busy,
  };
}

module.exports = {
  pipelineData,
  profileFromSettings,
  publish,
  generate,
  check,
  getStatus,
  isSkip,
  isBusy,
  waitIdle,
  zonedNow,
};
