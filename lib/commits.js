const { cleanError } = require("./crypto");
const { formatInput, trimFiles } = require("./services");

// Вкладка «Коммиты»: ручной выбор коммитов и пост из них. Работает отдельно от автоматической
// проверки и не трогает её состояние (last_sha, debounce).
// Форматы ответов GitHub — по документации REST API:
//   GET /repos/{repo}/commits?sha&author&since&until&per_page&page → [{ sha, commit: { message, author: { name, date } }, author: { login }, parents }]
//   GET /repos/{repo}/commits/{ref} → тот же коммит + files: [{ filename, status, additions, deletions, patch? }]
//   GET /repos/{repo}/branches?per_page&page → [{ name, commit: { sha }, protected }]
//   Пагинация: заголовок link с rel="next"; лимиты: 403/429, retry-after или x-ratelimit-reset.

const PER_PAGE = 30;
const MAX_PAGE = 10; // 10 × 30 = 300 коммитов: дальше «Искать глубже» не ходит
const MAX_SELECTED = 20;
const CACHE_TTL_MS = 60 * 1000;

const SHA_RE = /^[0-9a-f]{7,40}$/;
const AUTHOR_RE = /^[A-Za-z0-9._@+-]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class CommitsError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// Имя ветки по правилам git (упрощённо): без пробелов, «..», «//», «@{», управляющих символов
function isBranchName(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && /^[\w./-]+$/.test(v) &&
    !/(^[./-]|\/$|\.\.|\/\/|\.lock$|@\{)/.test(v);
}

/**
 * Проверка фильтров списка. Возвращает нормализованные параметры или бросает CommitsError.
 */
function parseListQuery(q, defaultBranch) {
  const branch = q.branch === undefined || q.branch === "" ? defaultBranch : String(q.branch);
  if (!isBranchName(branch)) throw new CommitsError("Некорректное имя ветки.");
  const page = q.page === undefined || q.page === "" ? 1 : Number(q.page);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new CommitsError(`Номер страницы должен быть от 1 до ${MAX_PAGE}: дальше 300 коммитов список не загружается.`);
  }
  const author = q.author ? String(q.author).trim() : "";
  if (author && !AUTHOR_RE.test(author)) throw new CommitsError("Автор: укажите логин GitHub или email.");
  const since = q.since ? String(q.since) : "";
  const until = q.until ? String(q.until) : "";
  for (const d of [since, until]) {
    if (d && (!DATE_RE.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z")))) throw new CommitsError("Даты периода — в формате ГГГГ-ММ-ДД.");
  }
  if (since && until && since > until) throw new CommitsError("Начало периода позже конца.");
  return { branch, page, author, since, until };
}

function parseShas(list) {
  if (!Array.isArray(list) || !list.length) throw new CommitsError("Выберите хотя бы один коммит.");
  const shas = [...new Set(list.map((s) => String(s).trim().toLowerCase()))];
  if (shas.length > MAX_SELECTED) throw new CommitsError(`За раз можно выбрать не больше ${MAX_SELECTED} коммитов.`);
  for (const sha of shas) if (!SHA_RE.test(sha)) throw new CommitsError("Некорректный идентификатор коммита.");
  return shas;
}

// Когда снова можно обращаться к GitHub после лимита
function retryAt(res) {
  const after = Number(res.headers?.get?.("retry-after"));
  if (after > 0) return new Date(Date.now() + after * 1000);
  if (res.headers?.get?.("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (reset > 0) return new Date(reset * 1000);
  }
  return new Date(Date.now() + 60 * 1000);
}

/**
 * Запрос к GitHub с понятными ошибками. what — что именно не найдено при 404 («ветка», «коммит»).
 */
async function ghJson(ctx, path, { what = "репозиторий" } = {}) {
  let res;
  try {
    res = await ctx.gh(path, ctx.get("github_token"), ctx);
  } catch (err) {
    const msg = /не ответил/.test(err.message) ? err.message + ". Попробуйте ещё раз." : "Нет связи с GitHub: проверьте интернет на сервере и нажмите «Обновить».";
    throw new CommitsError(cleanError(msg), 502);
  }
  if (res.status === 401) throw new CommitsError("GitHub не принял доступ: подключите GitHub заново в настройках.", 502);
  if (res.status === 403 || res.status === 429) {
    const limited = res.status === 429 || res.headers?.get?.("x-ratelimit-remaining") === "0" || res.headers?.get?.("retry-after");
    if (limited) {
      const at = retryAt(res);
      const when = at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: ctx.get("digest_tz", "Europe/Moscow") });
      throw new CommitsError(`Исчерпан лимит запросов к GitHub. Повторите после ${when}.`, 429, { retry_at: at.toISOString() });
    }
    throw new CommitsError("Нет доступа к репозиторию: проверьте, что у подключения GitHub есть доступ к нему.", 502);
  }
  if (res.status === 404 || res.status === 422) {
    throw new CommitsError(
      what === "ветка" ? "Ветка не найдена в репозитории, или к репозиторию нет доступа." : what === "коммит" ? "Коммит не найден в этом репозитории." : "Репозиторий не найден, или к нему нет доступа.",
      404
    );
  }
  if (res.status === 409) return { res, data: [] }; // пустой репозиторий
  if (!res.ok) throw new CommitsError(`GitHub ответил ошибкой ${res.status}. Попробуйте позже.`, 502);
  const data = await res.json().catch(() => null);
  if (data === null) throw new CommitsError("GitHub вернул неожиданный ответ. Попробуйте позже.", 502);
  return { res, data };
}

const hasNext = (res) => /rel="next"/.test(res.headers?.get?.("link") || "");

const summarize = (c) => {
  const message = String(c.commit?.message || "");
  return {
    sha: c.sha,
    short: String(c.sha).slice(0, 7),
    title: message.split("\n")[0],
    message,
    author: c.author?.login || c.commit?.author?.name || "",
    date: c.commit?.author?.date || c.commit?.committer?.date || null,
    merge: (c.parents?.length || 0) > 1,
  };
};

// ===== Кэш на 60 секунд =====
const cache = new Map();
function cached(key, refresh, load) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);
  return load().then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}
const clearCommitsCache = () => cache.clear();

function requireRepo(ctx) {
  const repo = ctx.get("repo");
  if (!ctx.get("github_installation_id") && !ctx.get("github_token")) {
    throw new CommitsError("GitHub не подключён.", 400, { code: "no_github" });
  }
  if (!repo) throw new CommitsError("Репозиторий не выбран.", 400, { code: "no_repo" });
  return repo;
}

/**
 * Страница коммитов ветки с номерами постов, в которых они уже использованы.
 */
async function listCommits(ctx, query, { refresh = false } = {}) {
  const repo = requireRepo(ctx);
  const f = parseListQuery(query, ctx.get("branch", "main"));
  const params = new URLSearchParams({ sha: f.branch, per_page: String(PER_PAGE), page: String(f.page) });
  if (f.author) params.set("author", f.author);
  if (f.since) params.set("since", f.since + "T00:00:00Z");
  if (f.until) params.set("until", f.until + "T23:59:59Z");

  const key = JSON.stringify(["list", repo, f]);
  const page = await cached(key, refresh, async () => {
    const { res, data } = await ghJson(ctx, `/repos/${repo}/commits?${params}`, { what: "ветка" });
    if (!Array.isArray(data)) throw new CommitsError("GitHub вернул неожиданный ответ. Попробуйте позже.", 502);
    return { commits: data.map(summarize), has_more: hasNext(res) && f.page < MAX_PAGE };
  });
  const used = ctx.postsForCommits(page.commits.map((c) => c.sha));
  return {
    branch: f.branch,
    page: f.page,
    per_page: PER_PAGE,
    has_more: page.has_more,
    commits: page.commits.map((c) => ({ ...c, posts: used[c.sha.toLowerCase()] || [] })),
  };
}

async function listBranches(ctx, { refresh = false } = {}) {
  const repo = requireRepo(ctx);
  return cached(JSON.stringify(["branches", repo]), refresh, async () => {
    const names = [];
    for (let page = 1; page <= 10; page++) {
      const { res, data } = await ghJson(ctx, `/repos/${repo}/branches?per_page=100&page=${page}`);
      if (!Array.isArray(data)) break;
      names.push(...data.map((b) => ({ name: b.name, protected: !!b.protected })));
      if (!hasNext(res)) break;
    }
    return { branches: names, default: ctx.get("branch", "main") };
  });
}

// Один коммит с файлами: подтверждает, что sha принадлежит репозиторию
async function getCommit(ctx, sha, { refresh = false } = {}) {
  const repo = requireRepo(ctx);
  if (!SHA_RE.test(String(sha || ""))) throw new CommitsError("Некорректный идентификатор коммита.");
  return cached(JSON.stringify(["commit", repo, sha]), refresh, async () => {
    const { data } = await ghJson(ctx, `/repos/${repo}/commits/${sha}`, { what: "коммит" });
    if (!data?.sha) throw new CommitsError("Коммит не найден в этом репозитории.", 404);
    return {
      ...summarize(data),
      files: (data.files || []).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
    };
  });
}

/**
 * Пост из выбранных коммитов. Всегда черновик, ИИ пишет текст в фоне (без SKIP).
 * Возвращает { id } или бросает CommitsError (409 — коммиты уже есть в постах).
 */
async function createPostFromCommits(ctx, body, { generate }) {
  requireRepo(ctx);
  const shas = parseShas(body?.shas);
  if (body?.branch !== undefined && body.branch !== "" && !isBranchName(String(body.branch))) {
    throw new CommitsError("Некорректное имя ветки.");
  }

  // Каждый sha подтверждаем запросом к GitHub: так он точно из этого репозитория, заодно берём файлы
  const commits = [];
  for (const sha of shas) commits.push(await getCommit(ctx, sha));
  const unique = [...new Map(commits.map((c) => [c.sha, c])).values()];
  unique.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const used = ctx.postsForCommits(unique.map((c) => c.sha));
  const duplicates = unique.filter((c) => used[c.sha.toLowerCase()]).map((c) => ({ sha: c.sha, short: c.short, posts: used[c.sha.toLowerCase()] }));
  if (duplicates.length && body.confirm_duplicates !== true) {
    throw new CommitsError("Часть коммитов уже использована в постах.", 409, { duplicates });
  }

  // Файлы нескольких коммитов: один файл — одна строка, изменения суммируются, diff склеивается
  const files = new Map();
  for (const c of [...unique].reverse()) {
    for (const f of c.files) {
      const cur = files.get(f.filename) || { filename: f.filename, additions: 0, deletions: 0, patch: "" };
      cur.additions += f.additions || 0;
      cur.deletions += f.deletions || 0;
      if (f.patch) cur.patch += (cur.patch ? "\n" : "") + f.patch;
      files.set(f.filename, cur);
    }
  }
  const input = formatInput(unique.map((c) => c.message), [...files.values()]);
  const inputData = { commits: unique.map((c) => ({ sha: c.sha, message: c.message })), files: trimFiles([...files.values()]) };
  const summary = unique.map((c) => ({ sha: c.sha, message: c.title, date: c.date }));

  // Пояснение автора ко всему посту (необязательно)
  const note = String(body?.note ?? "").trim();
  if (note.length > 500) throw new CommitsError("Пояснение к посту — не длиннее 500 символов.");
  const notes = note ? JSON.stringify({ post: note, commits: {} }) : null;

  const id = ctx.db.transaction(() => {
    const info = ctx.db
      .prepare("insert into posts(head,input,input_data,notes,kind,commits,status) values(?,?,?,?,'commit',?,'generating')")
      .run(unique[0].sha, input, JSON.stringify(inputData), notes, JSON.stringify(summary));
    const postId = Number(info.lastInsertRowid);
    ctx.recordPostCommits(postId, unique.map((c) => c.sha));
    return postId;
  })();

  // force: человек выбрал коммиты сам, ответ SKIP не принимается; без автопубликации и уведомлений
  generate(id, true, ctx, false, { locked: true, autoPublish: false, notify: false }).catch((err) =>
    ctx.db.prepare("update posts set status='failed', error=? where id=? and status='generating'").run(cleanError(err.message), id)
  );
  return { id, commits: unique.length };
}

module.exports = {
  PER_PAGE,
  MAX_PAGE,
  MAX_SELECTED,
  CACHE_TTL_MS,
  CommitsError,
  isBranchName,
  parseListQuery,
  parseShas,
  listCommits,
  listBranches,
  getCommit,
  createPostFromCommits,
  clearCommitsCache,
};
