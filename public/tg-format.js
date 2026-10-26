/**
 * Разметка поста для Telegram: одно правило для отправки (lib/poster.js) и для предпросмотра в панели.
 * Символов разметки в тексте нет: жирное передаётся через entities, поэтому ** и <b> в канале не появятся.
 * Жирным становятся:
 *   - первая строка, если это заголовок от конвейера (headline);
 *   - строки-подзаголовки (sections): до 60 символов, заканчиваются на «?» или «:»,
 *     и сразу под ними, без пустой строки, идёт текст раздела.
 * Смещения — в единицах UTF-16, как считает Telegram (и как устроены строки JavaScript).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TgFormat = api;
})(typeof self !== "undefined" ? self : this, function () {
  const SECTION_MAX = 60;

  function boldRanges(text, { headline = false, sections = false } = {}) {
    const lines = String(text || "").split("\n");
    const out = [];
    let pos = 0;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed) {
        const offset = pos + (line.length - line.trimStart().length);
        const isHead = i === 0 && headline;
        const isSection = sections && trimmed.length <= SECTION_MAX && /[?:]$/.test(trimmed) && !!(lines[i + 1] || "").trim();
        if (isHead || isSection) out.push({ offset, length: trimmed.length });
      }
      pos += line.length + 1;
    });
    return out;
  }

  const entitiesOf = (text, opts) => boldRanges(text, opts).map((r) => ({ type: "bold", offset: r.offset, length: r.length }));

  return { SECTION_MAX, boldRanges, entitiesOf };
});
