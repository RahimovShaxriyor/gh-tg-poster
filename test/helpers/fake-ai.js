// Поддельный ИИ для тестов конвейера: отвечает по шагам (факты → текст → проверка).
// Шаг берётся из req.step, а для запросов через fetch — из начала системного промпта.

const STEP_BY_PROMPT = [
  ["Задача: извлечь факты", "facts"],
  ["Задача: придумать заходы", "angles"],
  ["Задача: написать пост", "write"],
  ["Задача: проверить пост", "verify"],
  ["Задача: выписать объявленное", "extract"],
];

const stepOf = (req) => req.step || STEP_BY_PROMPT.find(([p]) => String(req.system || "").startsWith(p))?.[1] || "unknown";

// Первый короткий sha из блока коммитов («- [abc1234] …»), если он есть
const firstSha = (user) => String(user || "").match(/^- \[([^\]\s]+)\]/m)?.[1] || null;

const defaultFacts = (req) => {
  const sha = firstSha(req.user);
  return [{ id: "f1", claim: "Добавлена новая возможность", feature: "Новая возможность", evidence: sha ? [{ sha, file: null }] : [], user_visible: true, confidence: "high" }];
};

/**
 * fakeAi({ text, facts, unsupported, calls }) → async (req) => ответ.
 *   text: строка поста или функция (req, n) → строка; "SKIP" → {"skip":true}; null → пустой ответ
 *   facts: массив фактов или функция (req) → массив; строка — отдаётся как есть
 *   unsupported: массив замечаний проверки или функция (req, n) → массив
 *   angles: массив заходов или функция (req) → массив; строка — отдаётся как есть
 *   raw: { facts?, angles?, write?, verify? } — ответ шага строкой как есть
 *   calls: массив, куда пишутся запросы { step, system, user, model, temperature }
 */
const defaultAngles = [
  { type: "benefit", name: "Польза", hook: "Теперь это можно сделать быстрее", idea: "Что читатель может сделать" },
  { type: "story", name: "Закулисье", hook: "Как появилась новая возможность", idea: "Как это устроено" },
  { type: "question", name: "Вопрос", hook: "Часто делаете это вручную?", idea: "Вопрос к читателям" },
];

function fakeAi({ text = "Готовый пост", facts = defaultFacts, angles = defaultAngles, unsupported = [], raw = {}, calls = [] } = {}) {
  const counts = {};
  return async (req) => {
    const step = stepOf(req);
    counts[step] = (counts[step] || 0) + 1;
    calls.push({ ...req, step });
    if (raw[step] !== undefined) return typeof raw[step] === "function" ? raw[step](req, counts[step]) : raw[step];
    if (step === "facts") {
      const list = typeof facts === "function" ? facts(req) : facts;
      return typeof list === "string" ? list : JSON.stringify({ facts: list });
    }
    if (step === "angles") {
      const list = typeof angles === "function" ? angles(req) : angles;
      return typeof list === "string" ? list : JSON.stringify({ focus: "Главное для читателя", angles: list });
    }
    if (step === "write") {
      const t = typeof text === "function" ? text(req, counts[step]) : text;
      if (t === null || t === undefined) return "";
      if (t === "SKIP") return '{"skip":true}';
      return JSON.stringify({ text: t, used_facts: ["f1"], sentences: [], skipped: [] });
    }
    if (step === "verify") {
      const list = typeof unsupported === "function" ? unsupported(req, counts[step]) : unsupported;
      return JSON.stringify({ unsupported: list });
    }
    if (step === "extract") return JSON.stringify({ items: [{ name: "Тёмная тема", summary: "Тёмная тема оформления" }] });
    return "";
  };
}

/**
 * Обработчик fetch для api.anthropic.com поверх fakeAi: (url, opts) → Response.
 */
function anthropicFetch(options) {
  const ai = fakeAi(options);
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const text = await ai({ system: body.system, user: body.messages[0].content, model: body.model, temperature: body.temperature });
    return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" }), { status: 200 });
  };
}

/**
 * Адаптер для старых моков «ИИ возвращает текст поста»: fn(req) вызывается на шаге написания,
 * факты — по умолчанию (один ясный факт), проверка замечаний не находит. Ответ «SKIP» и пустой
 * ответ передаются как есть, остальное оборачивается в JSON шага написания.
 */
function postAi(fn, options = {}) {
  return fakeAi({
    ...options,
    raw: {
      write: async (req) => {
        const t = await fn(req);
        const s = String(t ?? "");
        if (!s.trim() || /^[\s*_`"'«».!:-]*skip[\s*_`"'«».!:-]*$/i.test(s)) return s;
        return JSON.stringify({ text: s, used_facts: ["f1"], sentences: [], skipped: [] });
      },
      ...(options.raw || {}),
    },
  });
}

module.exports = { fakeAi, postAi, defaultFacts, defaultAngles, anthropicFetch, stepOf, firstSha };
