// Команды и кнопки бота в личке владельца.
// Отвечает только владельцу: проверку отправителя делает handleUpdate в telegram-bot.js.
// Опасные действия (отклонить, не публиковать, удалить из канала, сменить репозиторий или ветку,
// отвязать владельца, тестовый пост в канал) — только через кнопку подтверждения с одноразовым
// nonce и таймаутом 60 секунд. Переключить режим «Публиковать сразу» из бота нельзя.

const fs = require("fs");
const path = require("path");
const { cleanError } = require("./crypto");
const { publish, generate, check, variant, aiCaller } = require("./poster");
const { textHash, panelUrl, draftMessage, reviewLine, botToken, channelAccess } = require("./notify");
const commitsLib = require("./commits");

const CONFIRM_TTL_MS = 60 * 1000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const PAGE_SIZE = 5;
const NOTE_MAX = 500;

// ===== Список команд (setMyCommands) и /help =====

const GROUPS = [
  ["Посты", [
    ["drafts", "Черновики, которые ждут публикации", "/drafts"],
    ["last", "Последние опубликованные посты", "/last 5"],
    ["post", "Показать пост с кнопками действий", "/post 12"],
    ["note", "Пояснение автора к посту", "/note 12 Экспорт нужен для отчётов"],
    ["regen", "Другой вариант черновика", "/regen 12 короче"],
    ["tone", "Быстрая правка: короче, ярче, проще, подробнее", "/tone проще"],
    ["skip", "Пометить пост «не публиковать»", "/skip 12"],
  ]],
  ["Коммиты", [
    ["check", "Проверить новые коммиты сейчас", "/check"],
    ["commits", "Последние коммиты ветки и пост из них", "/commits 10"],
    ["diff", "Какие файлы изменил коммит", "/diff 4f2a9c1"],
    ["since", "Коммиты за период: 12h, 2d, 1w", "/since 2d"],
    ["branches", "Ветки и смена отслеживаемой", "/branches"],
  ]],
  ["Состояние и управление", [
    ["status", "Репозиторий, режим, черновики, ошибки", "/status"],
    ["pause", "Приостановить автоматическую проверку", "/pause"],
    ["resume", "Возобновить автоматическую проверку", "/resume"],
    ["mode", "Режим: из бота — только «черновики»", "/mode approve"],
    ["repo", "Текущий репозиторий и смена", "/repo список"],
    ["stats", "Статистика за 7 и 30 дней", "/stats"],
    ["ai", "Провайдер и модель ИИ, проверка", "/ai"],
    ["test", "Тестовое сообщение", "/test"],
    ["channel", "Канал и права бота", "/channel"],
    ["panel", "Ссылка на панель", "/panel"],
    ["whoami", "Какой Telegram привязан к аккаунту", "/whoami"],
    ["unbind", "Отвязать Telegram от аккаунта", "/unbind"],
    ["health", "Версия, время работы, сервисы", "/health"],
    ["backup", "Когда была последняя резервная копия", "/backup"],
    ["help", "Список команд", "/help"],
  ]],
];

const COMMANDS = GROUPS.flatMap(([, list]) => list.map(([command, description]) => ({ command, description })));

const HELP_TEXT = [
  ...GROUPS.flatMap(([title, list]) => [`${title}:`, ...list.map(([cmd, desc, example]) => `/${cmd} — ${desc}${example !== "/" + cmd ? ` (${example})` : ""}`), ""]),
  "Пост уходит в канал только после кнопки «Опубликовать». Режим «Публиковать сразу» включается только в панели.",
].join("\n");

// ===== Мелкие помощники =====

const keyboard = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const btn = (text, data) => ({ text, callback_data: data });
const regenRejectRow = (id, regenLabel = "Другой вариант") => [btn(regenLabel, `regen:${id}`), btn("Отклонить", `rej:${id}`)];

// Даты SQLite (datetime('now')) хранятся в UTC без пояса
const toDate = (v) => {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(v) ? v.replace(" ", "T") + "Z" : v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function formatDate(iso, ctx) {
  const d = toDate(iso);
  if (!d) return "";
  const opts = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return d.toLocaleString("ru-RU", { ...opts, timeZone: ctx.get("digest_tz", "Europe/Moscow") });
  } catch {
    return d.toLocaleString("ru-RU", { ...opts, timeZone: "UTC" }) + " UTC";
  }
}

function age(iso) {
  const d = toDate(iso);
  if (!d) return "";
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (min < 60) return `${min} мин`;
  if (min < 48 * 60) return `${Math.round(min / 60)} ч`;
  return `${Math.round(min / 1440)} дн`;
}

const firstLine = (text, max = 70) => {
  const line = String(text || "").split("\n").find((l) => l.trim()) || "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

const MODE_NAMES = {
  approve: "черновики, публикация по кнопке",
  auto: "публикация сразу",
  digest: "дайджест раз в день",
};

const STATUS_NAMES = {
  draft: "черновик", generating: "пишется", sending: "отправляется", sent: "опубликован",
  failed: "ошибка", skipped: "пропущен", rejected: "не публикуется",
};

// Ссылка на сообщение в канале — только для публичного канала (@имя)
function postLink(ctx, p) {
  const ch = String(ctx.get("channel_id") || "");
  return ch.startsWith("@") && p.tg_message_id ? `https://t.me/${ch.slice(1)}/${p.tg_message_id}` : "";
}

const parseJson = (v, d = null) => {
  try {
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};

const activeDraft = (ctx) => ctx.db.prepare("select * from posts where user_id=? and status='draft' order by id desc limit 1").get(ctx.userId);
const postNumber = (arg) => (/^#?\d+$/.test(String(arg || "")) ? Number(String(arg).replace("#", "")) : null);

// Слова подсказок для /regen и /tone → подсказки перегенерации (lib/pipeline.js REWRITE_HINTS)
const HINT_WORDS = {
  короче: "shorter", короткий: "shorter", ярче: "brighter", живее: "brighter", проще: "simpler",
  подробнее: "detailed", подробно: "detailed", польза: "benefit", пользы: "benefit", "больше пользы": "benefit",
};
const hintOf = (words) => HINT_WORDS[String(words || "").trim().toLowerCase()] || null;

// ===== Ограничение частоты команд владельца =====
const hits = new Map();
function rateLimited(chatId) {
  const now = Date.now();
  const list = (hits.get(chatId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(chatId, list);
  // Предупреждаем один раз, дальше молчим до конца окна
  if (list.length === RATE_LIMIT + 1) return "warn";
  return list.length > RATE_LIMIT ? "silent" : null;
}
const resetRateLimit = () => hits.clear();

// ===== Сообщения о постах =====

function postResultMessage(ctx, id) {
  const p = ctx.post(id);
  if (!p) return { text: `Пост #${id} не найден.` };
  if (p.status === "draft") return draftMessage(p, ctx);
  if (p.status === "skipped") {
    return { text: `Пост #${id}: ИИ решил, что подписчикам эти изменения неинтересны.`, reply_markup: keyboard(regenRejectRow(id, "Всё равно написать")) };
  }
  if (p.status === "sent") return { text: `Пост #${id} опубликован в канал.` };
  if (p.status === "failed") {
    return { text: `Не удалось написать пост #${id}: ${p.error || "неизвестная ошибка"}`, reply_markup: keyboard(regenRejectRow(id)) };
  }
  return { text: `Пост #${id}: статус «${STATUS_NAMES[p.status] || p.status}».` };
}

// Пост целиком с кнопками действий по статусу. back — кнопка возврата к списку черновиков
function postView(ctx, p, { back = null } = {}) {
  const text = String(p.text || "");
  const preview = text.length > 3300 ? text.slice(0, 3300) + "…\n(текст сокращён, полностью — в панели)" : text;
  const head = `${p.kind === "digest" ? "Дайджест" : "Пост"} #${p.id} · ${STATUS_NAMES[p.status] || p.status} · создан ${formatDate(p.created_at, ctx)}`;
  const lines = [head, "", preview || "(текста пока нет)"];
  if (p.error) lines.push("", `Внимание: ${p.error}`);
  if (p.needs_review) lines.push("", "⚠️ " + reviewLine(p));
  const rows = [];
  if (p.status === "draft") {
    rows.push([btn("Опубликовать", `${p.needs_review ? "pubc" : "pub"}:${p.id}:${textHash(text)}`), btn("Другой вариант", `regen:${p.id}`)]);
    if (parseJson(p.meta)?.variants?.length) rows.push([btn("Короче", `tn:${p.id}:shorter`), btn("Проще", `tn:${p.id}:simpler`), btn("Ярче", `tn:${p.id}:brighter`)]);
    rows.push([btn("Отклонить", `rej:${p.id}`)]);
  } else if (p.status === "failed") {
    if (text) rows.push([btn("Отправить снова", `pub:${p.id}:${textHash(text)}`)]);
    rows.push(regenRejectRow(p.id, text ? "Другой вариант" : "Написать заново"));
  } else if (p.status === "skipped" || p.status === "rejected") {
    rows.push([btn("Написать заново", `regen:${p.id}`)]);
  } else if (p.status === "sent") {
    const link = postLink(ctx, p);
    if (link) rows.push([{ text: "Открыть в канале", url: link }]);
    if (p.tg_message_id) rows.push([btn("Удалить из канала", `dc:${p.id}`)]);
  }
  if (back !== null) rows.push([btn("← К черновикам", `dl:${back}`)]);
  return { text: lines.join("\n"), reply_markup: keyboard(...rows) };
}

function draftsPage(ctx, page = 0) {
  const total = ctx.db.prepare("select count(*) as c from posts where user_id=? and status='draft'").get(ctx.userId).c;
  if (!total) return { text: "Черновиков нет. /check — проверить новые коммиты, /commits — сделать пост из выбранных." };
  const pages = Math.ceil(total / PAGE_SIZE);
  const p = Math.min(Math.max(0, page), pages - 1);
  const list = ctx.db.prepare("select id, text, created_at, needs_review from posts where user_id=? and status='draft' order by id desc limit ? offset ?").all(ctx.userId, PAGE_SIZE, p * PAGE_SIZE);
  const lines = [`Черновики: ${total}${pages > 1 ? ` · страница ${p + 1} из ${pages}` : ""}`, ""];
  for (const d of list) lines.push(`#${d.id} · ${age(d.created_at)} назад${d.needs_review ? " · ⚠️ требует проверки" : ""}\n${firstLine(d.text) || "(без текста)"}`);
  const rows = list.map((d) => [btn(`Открыть #${d.id}`, `po:${d.id}:${p}`)]);
  if (pages > 1) rows.push([...(p > 0 ? [btn("← Назад", `dl:${p - 1}`)] : []), ...(p < pages - 1 ? [btn("Дальше →", `dl:${p + 1}`)] : [])]);
  return { text: lines.join("\n"), reply_markup: keyboard(...rows) };
}

// ===== /status и /check =====

function statusText(ctx) {
  const repo = ctx.get("repo");
  const lastCheck = ctx.get("last_check");
  const lastError = ctx.get("last_error");
  const drafts = ctx.getCounts ? ctx.getCounts().draft : 0;
  const channel = ctx.get("channel_id");
  const paused = ctx.get("paused") === "1";
  const lines = [
    `Репозиторий: ${repo ? `${repo}, ветка ${ctx.get("branch", "main")}` : "не выбран"}`,
    `Режим: ${MODE_NAMES[ctx.get("mode", "approve")] || ctx.get("mode")}`,
  ];
  const interval = Number(ctx.get("poll_interval", "5")) || 5;
  const next = typeof ctx.getNextPollAt === "function" ? ctx.getNextPollAt(ctx.userId) : null;
  lines.push(paused
    ? "Автопроверка: на паузе (/resume — возобновить)"
    : `Автопроверка: каждые ${interval} мин${next ? `, следующая ${formatDate(new Date(next).toISOString(), ctx)}` : ""}`);
  lines.push(`Последняя проверка: ${lastCheck ? formatDate(lastCheck, ctx) : "ещё не было"}`);
  if (lastError) lines.push(`Ошибка проверки: ${lastError}`);
  lines.push(`Черновиков ждёт: ${drafts}`);
  const lastSent = ctx.db?.prepare("select id, sent_at, created_at from posts where user_id=? and status='sent' order by coalesce(sent_at, created_at) desc limit 1").get(ctx.userId);
  lines.push(`Последний опубликованный: ${lastSent ? `#${lastSent.id}, ${formatDate(lastSent.sent_at || lastSent.created_at, ctx)}` : "ещё не было"}`);
  lines.push(`Канал: ${channel ? `подключён (${channel})` : "не подключён"}`);
  lines.push(`ИИ: ${ctx.get("ai_provider", "anthropic")}, ${ctx.get("ai_model") || "модель не выбрана"}`);
  const github = ctx.get("github_installation_id") ? "подключён (приложение)" : ctx.get("github_token") ? "подключён (токен)" : "не подключён";
  lines.push(`GitHub: ${github}${lastError ? ", последняя проверка с ошибкой" : ""}`);
  if (typeof ctx.recentEvents === "function") {
    const events = ctx.recentEvents(24, 50);
    lines.push(`Ошибок за 24 часа: ${events.length}`);
    for (const e of events.slice(0, 3)) lines.push(`• ${formatDate(e.ts, ctx)}: ${String(e.message).slice(0, 140)}`);
  }
  return lines.join("\n");
}

async function runCheckCommand(ctx, send) {
  const result = await check(true, ctx, { silent: true });
  const latest = result.latest ? `${result.latest.sha.slice(0, 7)}, ${formatDate(result.latest.date, ctx)}` : "";

  switch (result.status) {
    case "busy":
      return send({ text: "Проверка уже идёт. Повторите /check через минуту." });
    case "not_configured":
      return send({ text: `GitHub или репозиторий не настроены. Откройте панель: ${panelUrl(ctx)}` });
    case "error":
      return send({ text: `Не удалось проверить GitHub: ${result.error}` });
    case "first_run":
      return send({ text: `Репозиторий подключён, запомнил последний коммит: ${latest}. Посты будут с новых коммитов.` });
    case "created":
      for (const p of result.posts) await send(postResultMessage(ctx, p.id));
      return null;
    default:
      return send({ text: latest ? `Новых коммитов нет. Последний: ${latest}` : "Новых коммитов нет. В ветке пока нет коммитов." });
  }
}

// ===== Коммиты =====

const LIST_KEY = "tg_commit_list";

function commitsMessage(ctx, list, { title, selecting = false } = {}) {
  const state = { shas: list.map((c) => c.sha), labels: list.map((c) => `${c.short} ${firstLine(c.title, 40)}`), selected: [] };
  ctx.set(LIST_KEY, JSON.stringify(state));
  return commitsView(ctx, state, { title, selecting, list });
}

function commitsView(ctx, state, { title = "", selecting = false, list = null } = {}) {
  if (selecting) {
    const rows = state.labels.map((label, i) => [btn(`${state.selected.includes(i) ? "☑" : "☐"} ${label}`, `cs:${i}`)]);
    rows.push([btn(`Создать пост (${state.selected.length})`, "cc"), btn("Отмена", "cx")]);
    return { text: `${title || "Коммиты"}\n\nОтметьте коммиты и нажмите «Создать пост». Пост из выбранных коммитов — всегда черновик.`, reply_markup: keyboard(...rows) };
  }
  const lines = [title, ""];
  for (const [i, c] of (list || []).entries()) {
    const used = c.posts?.length ? ` · в посте ${c.posts.map((x) => "#" + x).join(", ")}` : "";
    lines.push(`${i + 1}. ${c.short} ${firstLine(c.title, 60)}${c.merge ? " (merge)" : ""}\n   ${c.author || ""}${c.date ? `, ${age(c.date)} назад` : ""}${used}`);
  }
  const rows = [];
  for (let i = 0; i < state.shas.length; i += 2) {
    rows.push(state.shas.slice(i, i + 2).map((sha) => btn(`Сделать пост ${sha.slice(0, 7)}`, `mk:${sha}`)));
  }
  if (state.shas.length > 1) rows.push([btn("Выбрать несколько", "sel")]);
  return { text: lines.join("\n").trim(), reply_markup: keyboard(...rows) };
}

function parsePeriod(arg) {
  const m = String(arg || "").trim().toLowerCase().match(/^(\d{1,3})\s*(h|ч|d|д|w|н)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const hours = { h: 1, ч: 1, d: 24, д: 24, w: 168, н: 168 }[m[2]] * n;
  if (!hours || hours > 24 * 90) return null;
  return { ms: hours * 3600e3, label: m[1] + ({ h: " ч", ч: " ч", d: " дн", д: " дн", w: " нед", н: " нед" }[m[2]]) };
}

async function createPost(ctx, shas, confirm, edit, send) {
  let r;
  try {
    r = await commitsLib.createPostFromCommits(ctx, { shas, confirm_duplicates: confirm }, { generate });
  } catch (err) {
    if (err.status === 409 && err.duplicates) {
      const nonce = ctx.createConfirm("dup", { shas }, CONFIRM_TTL_MS);
      const list = err.duplicates.map((d) => `${d.short} (в посте ${d.posts.map((x) => "#" + x).join(", ")})`).join(", ");
      return send({
        text: `Эти коммиты уже есть в постах: ${list}. Создать ещё один пост, в котором они повторятся? Кнопка действует 60 секунд.`,
        reply_markup: keyboard([btn("Да, создать", `ok:${nonce}`), btn("Отмена", `no:${nonce}`)]),
      });
    }
    return send({ text: "Не удалось создать пост: " + cleanError(err.message) });
  }
  await edit({ text: `Черновик #${r.id} создаётся из ${r.commits} ${r.commits === 1 ? "коммита" : "коммитов"}: ИИ пишет текст, пришлю, когда будет готов.` });
  r.done?.then(() => send(postResultMessage(ctx, r.id))).catch(() => {});
  return null;
}

// ===== Подтверждения =====

const CONFIRM_TEXT = {
  reject: (p) => [`Отклонить пост #${p.id}? Он не будет опубликован.`, "Да, отклонить"],
  skip: (p) => [`Пометить пост #${p.id} «не публиковать»?`, "Да, не публиковать"],
  delete_channel: (p) => [`Удалить пост #${p.id} из канала? Подписчики его больше не увидят.`, "Да, удалить"],
  branch: (p) => [`Отслеживать ветку «${p.branch}»? Состояние проверки сбросится: посты пойдут с новых коммитов этой ветки.`, "Да, сменить"],
  repo: (p) => [`Сменить репозиторий на ${p.repo} (ветка ${p.branch})? Состояние проверки сбросится.`, "Да, сменить"],
  unbind: () => ["Отвязать владельца? Бот перестанет отвечать вам, пока в панели не будет создан новый код привязки.", "Да, отвязать"],
  channel_test: (p) => [`Отправить тестовое сообщение в канал ${p.channel}? Его увидят подписчики.`, "Да, отправить"],
};

function askConfirm(ctx, action, payload) {
  const nonce = ctx.createConfirm(action, payload, CONFIRM_TTL_MS);
  const [question, yes] = CONFIRM_TEXT[action](payload);
  return { text: `${question}\n\nКнопка действует 60 секунд.`, reply_markup: keyboard([btn(yes, `ok:${nonce}`), btn("Отмена", `no:${nonce}`)]) };
}

// Смена репозитория или ветки: как в панели — сбрасываем last_sha и debounce
function resetTarget(ctx, { repo, branch }) {
  ctx.db.transaction(() => {
    if (repo !== undefined) ctx.set("repo", repo);
    if (branch !== undefined) ctx.set("branch", branch);
    for (const k of ["last_sha", "pending_head", "pending_at", "last_digest_sha"]) ctx.set(k, "");
  })();
  commitsLib.clearCommitsCache(ctx.userId);
}

async function runConfirmed(ctx, action, payload, token) {
  if (action === "reject" || action === "skip") {
    const res = ctx.db
      .prepare("update posts set status='rejected', error=? where id=? and user_id=? and status in ('draft','failed','skipped')")
      .run(action === "skip" ? "Не публиковать (отмечено в боте)" : null, payload.id, ctx.userId);
    return res.changes ? `Пост #${payload.id} ${action === "skip" ? "помечен «не публиковать»" : "отклонён"}.` : "Пост уже обработан: отправлен, отклонён или сейчас в работе.";
  }
  if (action === "delete_channel") {
    const p = ctx.post(payload.id);
    if (!p || p.status !== "sent" || !p.tg_message_id) return "Пост уже не в канале.";
    const access = await channelAccess(ctx, ctx.get("channel_id"), token);
    if (!access.ok) return access.error;
    const r = await ctx.tg("deleteMessage", { chat_id: ctx.get("channel_id"), message_id: p.tg_message_id }, token);
    if (!r?.ok) return "Не удалось удалить из канала: " + cleanError(r?.description || "неизвестная ошибка");
    ctx.db.prepare("update posts set status='rejected', error='Удалён из Telegram-канала', tg_message_id=null where id=? and user_id=? and status='sent'").run(p.id, ctx.userId);
    if (typeof ctx.deleteAnnouncedForPost === "function") ctx.deleteAnnouncedForPost(p.id);
    return `Пост #${p.id} удалён из канала.`;
  }
  if (action === "branch") {
    resetTarget(ctx, { branch: payload.branch });
    return `Теперь отслеживается ветка «${payload.branch}». Посты пойдут с новых коммитов.`;
  }
  if (action === "repo") {
    resetTarget(ctx, { repo: payload.repo, branch: payload.branch });
    return `Репозиторий: ${payload.repo}, ветка ${payload.branch}. Посты пойдут с новых коммитов.`;
  }
  if (action === "unbind") {
    const owner = ctx.get("tg_owner_chat_id");
    const { unregisterCommands } = require("./telegram-bot");
    await unregisterCommands(ctx, token, owner).catch(() => null);
    ctx.db.transaction(() => {
      for (const k of ["tg_owner_chat_id", "tg_owner_username", "tg_owner_bound_at"]) ctx.set(k, "");
      ctx.platform?.clearTgLinkCodes(ctx.userId);
    })();
    return "Telegram отвязан от аккаунта. Бот больше не отвечает здесь, пока в панели не создан новый код привязки.";
  }
  if (action === "channel_test") {
    const access = await channelAccess(ctx, ctx.get("channel_id"), token);
    if (!access.ok) return access.error;
    const r = await ctx.tg("sendMessage", { chat_id: ctx.get("channel_id"), text: "🔔 Тестовое сообщение от gh-tg-web: проверка связи с Telegram-каналом прошла успешно." }, token);
    if (!r?.ok) return "Ошибка Telegram: " + cleanError(r?.description || "неизвестная ошибка");
    ctx.set("test_post_sent", "1");
    return "Тестовое сообщение опубликовано в канале.";
  }
  if (action === "dup") return null; // обрабатывается отдельно: нужен send
  return "Неизвестное действие.";
}

// ===== Сведения о сервисе =====

function backupMarker(ctx) {
  const file = ctx.BACKUP_MARKER || path.join(ctx.dbPath && ctx.dbPath !== ":memory:" ? path.dirname(ctx.dbPath) : "data", "last-backup.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function appVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return require("../package.json").version || "dev";
  } catch {
    return "dev";
  }
}

function uptime() {
  const s = Math.floor(process.uptime());
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? d + " дн " : ""}${h} ч ${m} мин`;
}

function backupLine(ctx) {
  const m = backupMarker(ctx);
  if (!m?.at) return "Резервных копий ещё не было (или скрипт deploy/backup.sh не запускался).";
  const extra = [m.encrypted ? "зашифрована" : "без шифрования", m.uploaded ? "выгружена в S3" : null].filter(Boolean).join(", ");
  return `Последняя резервная копия: ${formatDate(m.at, ctx)} (${age(m.at)} назад)${extra ? ", " + extra : ""}.`;
}

// ===== Команды =====

const handlers = {
  async start({ send }) {
    return send({ text: HELP_TEXT });
  },
  async help({ send }) {
    return send({ text: HELP_TEXT });
  },
  async status({ ctx, send }) {
    return send({ text: statusText(ctx) });
  },
  async check({ ctx, send, chatId, tg }) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    // Генерация может идти минуту-две: не держим цикл обновлений, итог придёт отдельным сообщением
    runCheckCommand(ctx, send).catch((err) => send({ text: "Ошибка проверки: " + cleanError(err.message) }).catch(() => {}));
    return null;
  },

  // --- Посты ---
  async drafts({ ctx, send }) {
    return send(draftsPage(ctx, 0));
  },
  async last({ ctx, send, args }) {
    const n = args[0] === undefined ? 3 : Number(args[0]);
    if (!Number.isInteger(n) || n < 1) return send({ text: "Использование: /last или /last 5 (от 1 до 10)." });
    const list = ctx.db.prepare("select * from posts where user_id=? and status='sent' order by coalesce(sent_at, created_at) desc, id desc limit ?").all(ctx.userId, Math.min(n, 10));
    if (!list.length) return send({ text: "Опубликованных постов ещё нет." });
    const lines = list.map((p) => {
      const link = postLink(ctx, p);
      return `#${p.id} · ${formatDate(p.sent_at || p.created_at, ctx)}\n${firstLine(p.text)}${link ? "\n" + link : ""}`;
    });
    return send({ text: lines.join("\n\n"), disable_web_page_preview: true });
  },
  async post({ ctx, send, args }) {
    const id = postNumber(args[0]);
    if (!id) return send({ text: "Использование: /post 12 — номер поста из /drafts или из панели." });
    const p = ctx.post(id);
    if (!p) return send({ text: `Пост #${id} не найден.` });
    return send(postView(ctx, p));
  },
  async note({ ctx, send, args }) {
    const id = postNumber(args[0]);
    const text = args.slice(1).join(" ").trim();
    if (!id || !text) return send({ text: "Использование: /note 12 текст пояснения (до 500 символов)." });
    if (text.length > NOTE_MAX) return send({ text: `Пояснение длиннее ${NOTE_MAX} символов (${text.length}). Сократите его.` });
    const p = ctx.post(id);
    if (!p) return send({ text: `Пост #${id} не найден.` });
    if (["sent", "sending", "generating"].includes(p.status)) return send({ text: p.status === "sent" ? "Пост уже опубликован: пояснение к нему не нужно." : "Пост сейчас в работе, повторите через минуту." });
    const notes = parseJson(p.notes, {}) || {};
    ctx.db.prepare("update posts set notes=? where id=? and user_id=?").run(JSON.stringify({ post: text, commits: notes.commits || {} }), id, ctx.userId);
    return send({ text: `Пояснение к посту #${id} сохранено. ИИ учтёт его в следующем варианте.`, reply_markup: keyboard([btn("Написать заново", `regen:${id}`)]) });
  },
  async regen({ ctx, send, args }) {
    let id = postNumber(args[0]);
    const words = (id ? args.slice(1) : args).join(" ");
    const hint = words ? hintOf(words) : null;
    if (words && !hint) return send({ text: "Подсказки: короче, проще, ярче, подробнее, больше пользы. Например: /regen 12 короче" });
    const p = id ? ctx.post(id) : activeDraft(ctx);
    if (!p) return send({ text: id ? `Пост #${id} не найден.` : "Нет черновика. Укажите номер: /regen 12" });
    id = p.id;
    if (["sent", "sending"].includes(p.status)) return send({ text: "Этот пост уже опубликован или отправляется: менять его нельзя." });
    if (p.status === "generating") return send({ text: "Новый вариант уже готовится." });
    if (hint && p.status === "draft" && parseJson(p.meta)?.variants?.length) return rewrite(ctx, send, id, hint);
    await send({ text: `Пишу новый вариант поста #${id}…${hint ? " (подсказка учитывается только для черновиков с вариантами)" : ""}` });
    generate(id, true, ctx, p.kind === "digest", { notify: false })
      .then(() => send(postResultMessage(ctx, id)))
      .catch((err) => send({ text: `Пост #${id}: ${cleanError(err.message)}` }));
    return null;
  },
  async tone({ ctx, send, args }) {
    const hint = hintOf(args.join(" "));
    if (!hint) return send({ text: "Использование: /tone короче | ярче | проще | подробнее" });
    const p = activeDraft(ctx);
    if (!p) return send({ text: "Нет черновика для правки." });
    if (!parseJson(p.meta)?.variants?.length) return send({ text: `Черновик #${p.id} написан до появления вариантов: нажмите «Другой вариант» (/regen ${p.id}).` });
    return rewrite(ctx, send, p.id, hint);
  },
  async skip({ ctx, send, args }) {
    const id = postNumber(args[0]);
    if (!id) return send({ text: "Использование: /skip 12" });
    const p = ctx.post(id);
    if (!p) return send({ text: `Пост #${id} не найден.` });
    if (!["draft", "failed", "skipped"].includes(p.status)) return send({ text: `Пост #${id} уже ${STATUS_NAMES[p.status] || p.status}.` });
    return send(askConfirm(ctx, "skip", { id }));
  },

  // --- Коммиты ---
  async commits({ ctx, send, args }) {
    const n = args[0] === undefined ? 8 : Number(args[0]);
    if (!Number.isInteger(n) || n < 1) return send({ text: "Использование: /commits или /commits 15 (от 1 до 20)." });
    try {
      const page = await commitsLib.listCommits(ctx, {});
      const list = page.commits.slice(0, Math.min(n, 20));
      if (!list.length) return send({ text: `В ветке ${page.branch} нет коммитов.` });
      return send(commitsMessage(ctx, list, { title: `Последние коммиты ветки ${page.branch}: ${list.length}` }));
    } catch (err) {
      return send({ text: cleanError(err.message) });
    }
  },
  async diff({ ctx, send, args }) {
    const sha = String(args[0] || "").toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return send({ text: "Использование: /diff 4f2a9c1 (7–40 символов sha)." });
    try {
      const c = await commitsLib.getCommit(ctx, sha);
      const files = c.files.slice(0, 30).map((f) => `+${f.additions || 0} −${f.deletions || 0}  ${f.filename}`);
      const more = c.files.length > 30 ? `\n…и ещё ${c.files.length - 30}` : "";
      return send({ text: `${c.short} ${c.title}\n${c.author}${c.date ? ", " + formatDate(c.date, ctx) : ""}\n\nФайлы: ${c.files.length}\n${files.join("\n")}${more}`, reply_markup: keyboard([btn("Сделать пост", `mk:${c.sha}`)]) });
    } catch (err) {
      return send({ text: cleanError(err.message) });
    }
  },
  async since({ ctx, send, args }) {
    const period = parsePeriod(args[0]);
    if (!period) return send({ text: "Использование: /since 12h, /since 2d или /since 1w (до 90 дней)." });
    const from = new Date(Date.now() - period.ms);
    try {
      const page = await commitsLib.listCommits(ctx, { since: from.toISOString().slice(0, 10) }, { refresh: true });
      const list = page.commits.filter((c) => c.date && new Date(c.date) >= from).slice(0, 20);
      if (!list.length) return send({ text: `За последние ${period.label} коммитов в ветке ${page.branch} нет.` });
      return send(commitsMessage(ctx, list, { title: `Коммиты за ${period.label} (ветка ${page.branch}): ${list.length}${page.commits.length > 20 ? ", показаны первые 20" : ""}` }));
    } catch (err) {
      return send({ text: cleanError(err.message) });
    }
  },
  async branches({ ctx, send }) {
    try {
      const { branches } = await commitsLib.listBranches(ctx, { refresh: true });
      const current = ctx.get("branch", "main");
      const list = branches.slice(0, 20);
      ctx.set("tg_branch_list", JSON.stringify(list.map((b) => b.name)));
      const rows = list.filter((b) => b.name !== current).map((b) => [btn(`Отслеживать ${b.name}`.slice(0, 60), `br:${list.indexOf(b)}`)]);
      const text = [`Ветки (${branches.length}${branches.length > 20 ? ", показаны первые 20" : ""}):`, ...list.map((b) => `${b.name === current ? "● " : "  "}${b.name}${b.protected ? " (защищена)" : ""}`)].join("\n");
      return send({ text, reply_markup: keyboard(...rows) });
    } catch (err) {
      return send({ text: cleanError(err.message) });
    }
  },

  // --- Состояние и управление ---
  async pause({ ctx, send }) {
    ctx.set("paused", "1");
    return send({ text: "Автоматическая проверка на паузе. Черновики и кнопки работают, /check проверяет вручную. /resume — возобновить." });
  },
  async resume({ ctx, send }) {
    ctx.set("paused", "0");
    return send({ text: "Автоматическая проверка возобновлена." });
  },
  async mode({ ctx, send, args }) {
    const want = String(args[0] || "").toLowerCase();
    if (!want) return send({ text: `Режим: ${MODE_NAMES[ctx.get("mode", "approve")]}. Из бота можно включить только черновики: /mode approve` });
    if (want === "approve") {
      ctx.set("mode", "approve");
      return send({ text: "Режим: черновики, публикация по кнопке «Опубликовать»." });
    }
    return send({ text: "Этот режим включается только в панели (Настройки → Проверка). Из бота доступны /mode approve и /pause." });
  },
  async repo({ ctx, send, args }) {
    if (!args.length) {
      const repo = ctx.get("repo");
      return send({ text: repo ? `Репозиторий: ${repo}, ветка ${ctx.get("branch", "main")}.\n/repo список — сменить.` : "Репозиторий не выбран. /repo список — выбрать." });
    }
    if (!["список", "list"].includes(String(args[0]).toLowerCase())) return send({ text: "Использование: /repo или /repo список" });
    try {
      const repos = await commitsLib.listRepos(ctx);
      if (!repos.length) return send({ text: "Подключению GitHub не доступен ни один репозиторий. Выберите их на GitHub (Настройки → GitHub → «Выбрать репозитории»)." });
      const list = repos.slice(0, 20);
      ctx.set("tg_repo_list", JSON.stringify(list));
      const current = ctx.get("repo");
      return send({
        text: `Доступные репозитории (${repos.length}${repos.length > 20 ? ", показаны первые 20" : ""}). Текущий: ${current || "не выбран"}.`,
        reply_markup: keyboard(...list.map((r, i) => [btn(`${r.name === current ? "● " : ""}${r.name}`.slice(0, 60), `rp:${i}`)])),
      });
    } catch (err) {
      return send({ text: cleanError(err.message) });
    }
  },
  async stats({ ctx, send }) {
    const block = (days) => {
      const p = ctx.postStats(days);
      const u = ctx.usageStats(days);
      const tokens = (u.input + u.output).toLocaleString("ru-RU");
      const mark = u.estimated ? ` (оценка для ${u.estimated} из ${u.calls} вызовов: провайдер не сообщил токены)` : "";
      return [`За ${days} дней:`, `создано постов: ${p.created}, опубликовано: ${p.sent}, пропущено: ${p.skipped}, отклонено: ${p.rejected}`, `вызовов ИИ: ${u.calls}, токенов ≈ ${tokens} (вход ${u.input.toLocaleString("ru-RU")}, выход ${u.output.toLocaleString("ru-RU")})${mark}`].join("\n");
    };
    return send({ text: `${block(7)}\n\n${block(30)}` });
  },
  async ai({ ctx, send }) {
    const lines = [
      `Провайдер: ${ctx.get("ai_provider", "anthropic")}`,
      `Модель: ${ctx.get("ai_model") || "не выбрана"}`,
      `Модель для проверки: ${ctx.get("verify_model") || "та же"}`,
      `Строгая проверка: ${ctx.get("strict_check", "1") === "0" ? "выключена" : "включена"}`,
      `Ключ: ${ctx.get("ai_key") ? "задан" : "не задан"}`,
    ];
    return send({ text: lines.join("\n"), reply_markup: keyboard([btn("Проверить", "ai")]) });
  },
  async test({ ctx, send }) {
    const rows = ctx.get("channel_id") ? [[btn("Тестовый пост в канал", "ct")]] : [];
    return send({ text: "Тестовое сообщение: бот на связи и отвечает владельцу. ✅", reply_markup: keyboard(...rows) });
  },
  async channel({ ctx, send }) {
    const ch = ctx.get("channel_id");
    return send({ text: ch ? `Канал: ${ch}. Нажмите «Проверить», чтобы узнать права бота.` : "Канал не привязан: добавьте бота администратором канала со своего аккаунта или впишите @канал в панели.", reply_markup: keyboard([btn("Проверить", "ch")]) });
  },
  async panel({ ctx, send }) {
    return send({ text: `Панель: ${panelUrl(ctx)}` });
  },
  async whoami({ ctx, send }) {
    const bound = ctx.get("tg_owner_bound_at");
    return send({ text: `Владелец: ${ctx.get("tg_owner_username") || "без имени"} (ID ${ctx.get("tg_owner_chat_id")})${bound ? `, привязан ${formatDate(bound, ctx)}` : ""}.\n/unbind — отвязать.` });
  },
  async unbind({ ctx, send }) {
    return send(askConfirm(ctx, "unbind", {}));
  },
  async health({ ctx, send }) {
    const lastOk = ctx.get("last_ok_check");
    const lastError = ctx.get("last_error");
    const aiErrors = typeof ctx.recentEvents === "function" ? ctx.recentEvents(24, 50).filter((e) => e.kind === "generate").length : 0;
    const lines = [
      `Версия: ${appVersion()}`,
      `Работает: ${uptime()}`,
      `Последняя успешная проверка GitHub: ${lastOk ? formatDate(lastOk, ctx) : "ещё не было"}`,
      `GitHub: ${lastError ? "ошибка — " + lastError : "в порядке"}`,
      "Telegram: в порядке (вы читаете этот ответ)",
      `ИИ: ${aiErrors ? `ошибок генерации за 24 часа: ${aiErrors}` : "ошибок за 24 часа нет"}`,
      backupLine(ctx),
    ];
    return send({ text: lines.join("\n") });
  },
  async backup({ ctx, send }) {
    return send({ text: backupLine(ctx) + "\nКопии делает deploy/backup.sh на сервере (по таймеру раз в сутки); из бота копия не создаётся." });
  },
};
// /auto — частая попытка включить автопубликацию: объясняем, где это делается
handlers.auto = ({ send }) => send({ text: "Режим «Публиковать сразу» включается только в панели (Настройки → Проверка). Из бота доступны /mode approve и /pause." });

async function rewrite(ctx, send, id, hint) {
  await send({ text: `Пишу новую версию черновика #${id}…` });
  variant(id, ctx, { action: "rewrite", hint })
    .then(() => send(postResultMessage(ctx, id)))
    .catch((err) => send({ text: `Пост #${id}: ${cleanError(err.message)}` }));
  return null;
}

/**
 * Личное сообщение владельца. Чужие сюда не попадают (проверка в telegram-bot.js).
 */
async function handleOwnerMessage(ctx, { chatId, text, tg }) {
  const send = (payload) => tg("sendMessage", { chat_id: chatId, ...payload });
  const limited = rateLimited(chatId);
  if (limited === "warn") return send({ text: "Слишком много команд: не больше 30 в минуту. Подождите минуту." });
  if (limited) return null;
  if (!text.startsWith("/")) return send({ text: "Не понимаю сообщение. /help — список команд." });
  const [head, ...args] = text.split(/\s+/);
  const command = head.slice(1).split("@")[0].toLowerCase();
  const handler = Object.prototype.hasOwnProperty.call(handlers, command) ? handlers[command] : null;
  if (!handler) return send({ text: "Не знаю такой команды. /help — список команд." });
  try {
    return await handler({ ctx, send, args, chatId, tg });
  } catch (err) {
    return send({ text: "Не получилось: " + cleanError(err.message) + ". Повторите или откройте панель: " + panelUrl(ctx) });
  }
}

/**
 * Нажатие кнопки владельцем. Чужие нажатия отсекаются в telegram-bot.js.
 */
async function handleCallback(ctx, { cb, tg, token, owner }) {
  const answer = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) });
  const msg = cb.message;
  const edit = (payload) =>
    msg?.message_id && msg?.chat?.id
      ? tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, ...payload }).catch(() => {})
      : null;
  const editSuffix = (suffix) => edit({ text: `${msg?.text || ""}\n\n${suffix}` });
  const send = (payload) => tg("sendMessage", { chat_id: owner, ...payload });

  const data = String(cb.data || "");
  const [action, a1, a2] = data.split(":");

  try {
    // --- Подтверждения ---
    if (action === "ok" || action === "no") {
      if (action === "no") {
        ctx.dropConfirm(a1);
        await answer("Отменено.");
        return edit({ text: "Отменено." });
      }
      const c = ctx.takeConfirm(a1);
      if (!c) return answer("Уже выполнено или отменено.", true);
      if (c.expired) {
        await answer("Время подтверждения истекло.", true);
        return edit({ text: "Время подтверждения (60 секунд) истекло. Повторите команду." });
      }
      await answer();
      if (c.action === "dup") return createPost(ctx, c.payload.shas, true, edit, send);
      const result = await runConfirmed(ctx, c.action, c.payload, token);
      return edit({ text: result });
    }

    // --- Списки и навигация (редактируют то же сообщение) ---
    if (action === "dl") {
      await answer();
      return edit(draftsPage(ctx, Number(a1) || 0));
    }
    if (action === "po") {
      const p = ctx.post(Number(a1));
      if (!p) return answer("Пост не найден: возможно, его удалили в панели.", true);
      await answer();
      return edit(postView(ctx, p, { back: a2 === undefined ? null : Number(a2) || 0 }));
    }

    // --- Коммиты ---
    if (action === "mk" || action === "sel" || action === "cs" || action === "cc" || action === "cx") {
      const state = parseJson(ctx.get(LIST_KEY), null);
      if (action === "mk") {
        await answer("Создаю пост…");
        return createPost(ctx, [a1], false, edit, send);
      }
      if (!state) return answer("Список устарел: вызовите /commits ещё раз.", true);
      if (action === "sel") {
        state.selected = [];
        ctx.set(LIST_KEY, JSON.stringify(state));
        await answer();
        return edit(commitsView(ctx, state, { selecting: true }));
      }
      if (action === "cs") {
        const i = Number(a1);
        if (!Number.isInteger(i) || i < 0 || i >= state.shas.length) return answer("Список устарел: вызовите /commits ещё раз.", true);
        state.selected = state.selected.includes(i) ? state.selected.filter((x) => x !== i) : [...state.selected, i];
        ctx.set(LIST_KEY, JSON.stringify(state));
        await answer();
        return edit(commitsView(ctx, state, { selecting: true }));
      }
      if (action === "cx") {
        await answer("Отменено.");
        return edit({ text: "Выбор отменён. /commits — показать коммиты снова." });
      }
      if (!state.selected.length) return answer("Отметьте хотя бы один коммит.", true);
      const shas = state.selected.map((i) => state.shas[i]);
      ctx.set(LIST_KEY, "");
      await answer("Создаю пост…");
      return createPost(ctx, shas, false, edit, send);
    }

    // --- Ветки и репозитории: смена только через подтверждение ---
    if (action === "br" || action === "rp") {
      const list = parseJson(ctx.get(action === "br" ? "tg_branch_list" : "tg_repo_list"), []);
      const item = list[Number(a1)];
      if (!item) return answer("Список устарел: вызовите команду ещё раз.", true);
      await answer();
      return send(action === "br" ? askConfirm(ctx, "branch", { branch: item }) : askConfirm(ctx, "repo", { repo: item.name, branch: item.branch || "main" }));
    }

    // --- Проверки ---
    if (action === "ai") {
      await answer("Проверяю…");
      const key = ctx.get("ai_key");
      const model = ctx.get("ai_model");
      if (!key || !model) return edit({ text: "Ключ или модель ИИ не заданы: заполните их в панели (Настройки → ИИ)." });
      const started = Date.now();
      try {
        const call = aiCaller(ctx, { provider: ctx.get("ai_provider", "anthropic"), key, model, verifyModel: model });
        const resp = await call({ step: "test", system: "Ответь одним коротким предложением.", user: "Проверка связи. Ответь: связь есть." });
        const preview = String(resp || "").replace(/\s+/g, " ").trim().split(key).join("[СКРЫТО]").slice(0, 80);
        return edit({ text: `ИИ отвечает: ${((Date.now() - started) / 1000).toFixed(1)} с (${ctx.get("ai_provider", "anthropic")}, ${model})${preview ? `: «${preview}»` : ", но текст пустой."}` });
      } catch (err) {
        return edit({ text: "ИИ не ответил: " + cleanError(err.message).split(key).join("[СКРЫТО]") + ". Проверьте ключ и модель в панели." });
      }
    }
    if (action === "ch") {
      await answer("Проверяю…");
      const { checkChannel } = require("./telegram-bot");
      const r = await checkChannel(ctx);
      return edit({ text: (r.ok ? "✅ " : "⚠️ ") + r.message, reply_markup: keyboard([btn("Проверить ещё раз", "ch")]) });
    }
    if (action === "ct") {
      const ch = ctx.get("channel_id");
      if (!ch) return answer("Канал не привязан.", true);
      await answer();
      return send(askConfirm(ctx, "channel_test", { channel: ch }));
    }

    // --- Действия с постом ---
    const id = Number(a1);
    const p = ctx.post(id);
    if (!p) return answer("Пост не найден: возможно, его удалили в панели.", true);

    if (action === "pubc") {
      // Текст с непроверенными утверждениями: спрашиваем ещё раз, публикует только кнопка pub
      if (p.status !== "draft" && p.status !== "failed") return answer("Пост уже обработан: отправлен, отклонён или сейчас в работе.", true);
      await answer();
      return send({
        text: `В тексте поста #${id} есть непроверенные утверждения. ${reviewLine(p)}\n\nОпубликовать всё равно?`,
        reply_markup: keyboard([btn("Да, опубликовать", `pub:${id}:${a2 || textHash(p.text)}`)]),
      });
    }

    if (action === "pub" || action === "pubf") {
      // Текст изменился после этого сообщения (правка в панели или новый вариант): не публикуем вслепую
      if (a2 && textHash(p.text) !== a2) {
        await answer("Текст поста изменился. Прислал актуальную версию ниже.", true);
        if (p.status === "draft") await send(draftMessage(p, ctx));
        return null;
      }
      if (action === "pub" && p.status === "failed" && p.interrupted) {
        await answer();
        return send({
          text: `Отправка поста #${id} прервалась, и он мог уже появиться в канале. Проверьте канал. Если поста там нет, отправьте ещё раз.`,
          reply_markup: keyboard([btn("Отправить ещё раз", `pubf:${id}:${textHash(p.text)}`)]),
        });
      }
      await publish(id, null, ctx);
      await answer("Опубликовано в канал.");
      return editSuffix("Опубликован в канал.");
    }

    if (action === "regen") {
      await answer("Пишу новый вариант…");
      await edit({ text: `${p.kind === "digest" ? "Дайджест" : "Черновик"} #${id}\n\nПишу новый вариант…` });
      // Не держим цикл обновлений, пока ИИ пишет
      generate(id, true, ctx, p.kind === "digest", { notify: false })
        .then(() => edit(postResultMessage(ctx, id)))
        .catch((err) => edit({ text: `Пост #${id}: ${cleanError(err.message)}` }));
      return null;
    }

    if (action === "tn") {
      if (!["shorter", "simpler", "brighter", "detailed", "benefit"].includes(a2)) return answer();
      await answer("Пишу новую версию…");
      await edit({ text: `Черновик #${id}\n\nПишу новую версию…` });
      variant(id, ctx, { action: "rewrite", hint: a2 })
        .then(() => edit(postResultMessage(ctx, id)))
        .catch((err) => edit({ text: `Пост #${id}: ${cleanError(err.message)}` }));
      return null;
    }

    if (action === "rej") {
      if (!["draft", "failed", "skipped"].includes(p.status)) return answer("Пост уже обработан: отправлен, отклонён или сейчас в работе.", true);
      await answer();
      return send(askConfirm(ctx, "reject", { id }));
    }

    if (action === "dc") {
      if (p.status !== "sent" || !p.tg_message_id) return answer("Пост уже не в канале.", true);
      await answer();
      return send(askConfirm(ctx, "delete_channel", { id }));
    }

    return answer();
  } catch (err) {
    return answer("Ошибка: " + cleanError(err.message), true);
  }
}

module.exports = {
  CONFIRM_TTL_MS,
  RATE_LIMIT,
  PAGE_SIZE,
  COMMANDS,
  HELP_TEXT,
  GROUPS,
  MODE_NAMES,
  handlers,
  handleOwnerMessage,
  handleCallback,
  statusText,
  runCheckCommand,
  postResultMessage,
  postView,
  draftsPage,
  parsePeriod,
  hintOf,
  formatDate,
  resetRateLimit,
};
