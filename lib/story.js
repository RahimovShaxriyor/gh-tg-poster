// Project Update Story: то, что код знает о проекте и обновлении точно, — название, ветка, период,
// ссылка на GitHub, хештеги. ИИ получает это как данные (блок <project>), а дату, ссылку и хештеги
// не пишет: их добавляет к тексту код (подпись поста), чтобы они не могли быть выдуманы.

// Форматы поста: ориентир по длине и подробности. Короткий точный пост лучше растянутого
const FORMATS = {
  short: { name: "Короткое обновление", length: "400–700 символов", plan: "1–2 главных изменения, без разделов: заголовок и 1–2 абзаца." },
  story: { name: "История обновления", length: "800–1400 символов", plan: "заход, что изменилось, зачем (только если причина есть в фактах), что это даёт читателю. Разделы с подзаголовками — по желанию." },
  release: { name: "Подробный релиз", length: "1400–2200 символов", plan: "подробно: изменения сгруппированы по функциям (feature), у групп подзаголовки, затем зачем и что это даёт." },
};
const DEFAULT_FORMAT = "story";
const normalizeFormat = (v) => (FORMATS[v] ? v : DEFAULT_FORMAT);

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// owner/name, где ни одна часть не «.» и не «..» (то же правило, что при сохранении настроек)
const isRepo = (v) => REPO_RE.test(String(v || "")) && String(v).split("/").every((part) => part !== "." && part !== "..");
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MAX_COMMITS = 30;

// Дата в часовом поясе tz → { y, m, d } и подпись «26 октября». Неверный пояс — UTC
function zoned(date, tz) {
  const make = (timeZone) => ({
    parts: new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }),
    label: new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "long" }),
  });
  let f;
  try {
    f = make(tz || "UTC");
  } catch {
    f = make("UTC");
  }
  const p = Object.fromEntries(f.parts.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), label: f.label.format(date) };
}

/**
 * Период изменений по датам коммитов в часовом поясе настроек:
 * «26 октября 2026», «24–26 октября 2026», «30 сентября – 2 октября 2026», «30 декабря 2025 – 2 января 2026».
 */
function periodLabel(dates, tz) {
  // Пустая дата не должна превратиться в 1 января 1970
  const list = (dates || []).filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime())).sort((a, b) => a - b);
  if (!list.length) return "";
  const a = zoned(list[0], tz);
  const b = zoned(list[list.length - 1], tz);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${a.label} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.label} ${a.y}`;
  if (a.y === b.y) return `${a.label} – ${b.label} ${a.y}`;
  return `${a.label} ${a.y} – ${b.label} ${b.y}`;
}

/**
 * Ссылка, которая показывает именно описанные изменения: один коммит — сам коммит;
 * известна база проверки — сравнение base...head; иначе — история ветки до последнего коммита.
 */
function updateUrl(repo, commits, base) {
  if (!isRepo(repo) || !commits.length) return "";
  const gh = `https://github.com/${repo}`;
  const head = commits[commits.length - 1].sha;
  if (commits.length === 1) return `${gh}/commit/${head}`;
  if (SHA_RE.test(String(base || ""))) return `${gh}/compare/${String(base).slice(0, 12)}...${head.slice(0, 12)}`;
  return `${gh}/commits/${head}`;
}

// Тип обновления по conventional commits: только исправления, есть новая функция, или в общем
function updateType(kind, commits) {
  if (kind === "digest") return "дайджест";
  const titles = commits.map((c) => c.title);
  if (titles.length && titles.every((t) => /^fix(\(|!|:)/i.test(t))) return "исправление";
  if (titles.some((t) => /^feat(\(|!|:)/i.test(t))) return "новая_функция";
  return "обновление";
}

function hashtags(name, type, format) {
  const tag = String(name || "").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const list = [/[\p{L}_]/u.test(tag) ? tag : "", type, format === "short" ? "" : "buildinpublic"].filter(Boolean);
  return [...new Set(list)].map((t) => "#" + t).join(" ");
}

/**
 * Данные о проекте и обновлении для поста.
 *   repo — owner/name; commits — [{ sha, message (заголовок), date }] из posts.commits; base — sha, с которого
 *   начиналась проверка (если известен); name, about — название и описание проекта из настроек; tz — часовой пояс.
 */
function projectContext({ repo = "", branch = "", kind = "commit", commits = [], base = "", name = "", about = "", tz = "", format } = {}) {
  const list = (Array.isArray(commits) ? commits : [])
    .filter((c) => c && SHA_RE.test(String(c.sha || "")))
    .map((c) => ({ sha: String(c.sha).toLowerCase(), title: String(c.message || c.title || "").split("\n")[0].trim().slice(0, 200), date: c.date || null }))
    // От старого к новому: по дате, без даты — в исходном порядке (GitHub отдаёт новые первыми)
    .reverse()
    .sort((a, b) => (a.date && b.date ? new Date(a.date) - new Date(b.date) : 0))
    .slice(-MAX_COMMITS);
  const full = isRepo(repo) ? String(repo) : "";
  const projectName = String(name || "").trim().slice(0, 60) || full.split("/")[1] || "";
  const fmt = normalizeFormat(format);
  return {
    name: projectName,
    full_name: full,
    about: String(about || "").trim().slice(0, 300),
    branch: String(branch || "").slice(0, 100),
    kind: kind === "digest" ? "digest" : "commit",
    format: fmt,
    tz: tz || "UTC",
    commits: list,
    period: periodLabel(list.map((c) => c.date), tz),
    url: updateUrl(full, list, base),
    hashtags: hashtags(projectName, updateType(kind, list), fmt),
  };
}

/**
 * Подпись поста: дата коммитов, ссылка на GitHub и хештеги. Без эмодзи, если канал их не использует.
 * Дата — именно коммитов, а не публикации: подпись так и говорит.
 */
function footerOf(project, { emoji = "few" } = {}) {
  if (!project) return "";
  const icon = (e) => (emoji === "none" ? "" : e + " ");
  const lines = [];
  if (project.period) lines.push(`${icon("📅")}${project.commits.length > 1 ? "Коммиты" : "Дата коммита"}: ${project.period}`);
  if (project.url) lines.push(`${icon("🔗")}GitHub: ${project.url}`);
  if (project.hashtags) lines.push(project.hashtags);
  return lines.join("\n");
}

// Текст поста с подписью. Подпись хранится отдельно (meta.footer) и добавляется при отправке,
// поэтому правка или перегенерация текста не может испортить дату и ссылку
const withFooter = (text, footer) => (footer ? `${String(text || "").trimEnd()}\n\n${footer}` : String(text || ""));

module.exports = {
  FORMATS,
  DEFAULT_FORMAT,
  normalizeFormat,
  periodLabel,
  updateUrl,
  updateType,
  hashtags,
  projectContext,
  footerOf,
  withFooter,
};
