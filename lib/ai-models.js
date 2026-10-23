const crypto = require("crypto");
const { cleanError } = require("./crypto");

// Список моделей у провайдера по ключу пользователя: только подсказка, модель выбирает человек.
// Форматы ответов — по документации:
//   Anthropic: GET https://api.anthropic.com/v1/models?limit&after_id
//     → { data: [{ id, display_name, created_at (RFC 3339), lifecycle }], has_more, last_id }
//   OpenAI: GET https://api.openai.com/v1/models → { data: [{ id, created (Unix, секунды), owned_by }] }

const TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 20;

const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI" };

// Запасной список на случай, если провайдер недоступен. Может устареть.
const FALLBACK = {
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  openai: [],
};

// Модели OpenAI, которые не подходят для текстового чата: эмбеддинги, речь, картинки и видео,
// аудио и realtime, модерация, старые completion- и instruct-модели
const OPENAI_NOT_CHAT = /(embed|tts|whisper|transcri|dall-e|image|sora|audio|realtime|moderation|instruct|^babbage|^davinci)/i;

// «Обычно дешевле» — только по названию, без цен
const CHEAPER_BY_NAME = /(^|[-_.])(mini|nano|haiku)([-_.]|$)/i;

const cache = new Map();
const fingerprint = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
const cacheKey = (provider, key) => `${provider}:${fingerprint(key)}`;

class ModelsError extends Error {}

// Сообщение об ошибке без ключа: cleanError скрывает известные форматы, а сам ключ вырезается целиком
function safeMessage(text, key) {
  let msg = cleanError(String(text || ""));
  if (key) msg = msg.split(String(key)).join("[СКРЫТО]");
  return msg;
}

function httpError(provider, status, body, key) {
  const name = PROVIDER_NAMES[provider];
  if (status === 401) return `${name} не принял ключ (401). Проверьте ключ, вставьте его заново и нажмите «Сохранить».`;
  if (status === 403) return `${name}: нет доступа к списку моделей (403). Проверьте права ключа и статус аккаунта в кабинете ${name}.`;
  if (status === 429) return `${name}: слишком много запросов или исчерпан лимит (429). Подождите минуту и нажмите «Повторить»; если не помогает, проверьте баланс в кабинете ${name}.`;
  if (status >= 500) return `${name} временно недоступен (код ${status}). Повторите через несколько минут.`;
  const detail = body?.error?.message || body?.message || "";
  return `${name} вернул ошибку ${status}${detail ? ": " + safeMessage(detail, key) : ""}.`;
}

async function request(provider, url, headers, key, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new ModelsError(`${PROVIDER_NAMES[provider]} не ответил за ${TIMEOUT_MS / 1000} секунд. Нажмите «Повторить» чуть позже.`);
    }
    throw new ModelsError(`Нет связи с ${PROVIDER_NAMES[provider]}: проверьте интернет на сервере и нажмите «Повторить». (${safeMessage(err.message, key)})`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ModelsError(httpError(provider, res.status, body, key));
  if (!body || !Array.isArray(body.data)) {
    throw new ModelsError(`${PROVIDER_NAMES[provider]} вернул неожиданный ответ. Нажмите «Повторить».`);
  }
  return body;
}

async function fetchAnthropic(key, fetchFn) {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const models = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = "https://api.anthropic.com/v1/models?limit=1000" + (after ? "&after_id=" + encodeURIComponent(after) : "");
    const body = await request("anthropic", url, headers, key, fetchFn);
    for (const m of body.data) {
      if (!m?.id) continue;
      const created = Date.parse(m.created_at);
      models.push({
        id: String(m.id),
        name: m.display_name ? String(m.display_name) : "",
        created: Number.isFinite(created) ? Math.floor(created / 1000) : null,
        deprecated: m.lifecycle === "deprecated",
      });
    }
    if (!body.has_more || !body.last_id || body.last_id === after) break;
    after = body.last_id;
  }
  return models;
}

async function fetchOpenAI(key, fetchFn) {
  const body = await request("openai", "https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }, key, fetchFn);
  return body.data
    .filter((m) => m?.id && !OPENAI_NOT_CHAT.test(m.id))
    .map((m) => ({ id: String(m.id), name: "", created: Number.isFinite(m.created) ? m.created : null, deprecated: false }));
}

// Сначала новые (по дате выпуска), без даты — по имени
function sortModels(models) {
  return [...models].sort((a, b) => {
    if (a.created !== null && b.created !== null && a.created !== b.created) return b.created - a.created;
    if ((a.created === null) !== (b.created === null)) return a.created === null ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

const withTags = (models) => models.map((m) => ({ ...m, cheaper: CHEAPER_BY_NAME.test(m.id) }));

/**
 * Список моделей провайдера по ключу. Кэш в памяти на 10 минут для пары «провайдер + отпечаток ключа».
 * refresh=true сбрасывает кэш этой пары. Ошибки — ModelsError с понятным текстом без ключа.
 */
async function listModels(provider, key, { fetch: fetchFn = global.fetch, refresh = false } = {}) {
  if (!PROVIDER_NAMES[provider]) throw new ModelsError("Неизвестный провайдер ИИ.");
  if (!key) throw new ModelsError("Сначала введите ключ ИИ.");

  const ck = cacheKey(provider, key);
  const hit = cache.get(ck);
  if (refresh) cache.delete(ck);
  else if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { models: hit.models, fetched_at: new Date(hit.at).toISOString(), cached: true };

  const raw = provider === "anthropic" ? await fetchAnthropic(key, fetchFn) : await fetchOpenAI(key, fetchFn);
  const models = withTags(sortModels(raw));
  const at = Date.now();
  cache.set(ck, { at, models });
  return { models, fetched_at: new Date(at).toISOString(), cached: false };
}

const fallbackModels = (provider) => withTags((FALLBACK[provider] || []).map((id) => ({ id, name: "", created: null, deprecated: false })));

function clearModelsCache() {
  cache.clear();
}

module.exports = {
  listModels,
  fallbackModels,
  clearModelsCache,
  ModelsError,
  OPENAI_NOT_CHAT,
  CACHE_TTL_MS,
  TIMEOUT_MS,
  PROVIDER_NAMES,
};
