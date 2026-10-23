const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pipeline = require("../lib/pipeline");
const { fakeAi } = require("./helpers/fake-ai");

const SHA = "a".repeat(40);
const DATA = { commits: [{ sha: SHA, message: "feat: dashboard" }], files: [{ filename: "src/Admin.java", additions: 1, deletions: 0, patch: "+@PreAuthorize(\"hasRole('ADMIN')\")" }] };
const FACT = { id: "f1", claim: "Сводка сохраняется между перезапусками", feature: "Сводка", evidence: [{ sha: "aaaaaaa", file: null }], user_visible: true, confidence: "high" };

describe("Термины по аудитории", () => {
  it("находит термины, кальки, camelCase, PascalCase, snake_case, файлы и константы из diff; названия продуктов — не жаргон", () => {
    const words = pipeline.findJargon(
      "Новый endpoint, эндпоинт, DTO, сущности, репозиторий, снапшот, read model, bootstrap, контроллер, getUser, DashboardSnapshotService, user_id, app.js и ADMIN. GitHub и JavaScript ок, ссылка https://github.com/a/read_model не считается",
      new Set(["ADMIN"])
    ).map((f) => f.word);
    assert.deepEqual(words, ["endpoint", "эндпоинт", "DTO", "сущности", "репозиторий", "снапшот", "read model", "bootstrap", "контроллер", "getUser", "DashboardSnapshotService", "user_id", "app.js", "ADMIN"]);
  });

  it("пользователи: любое техническое слово — «слишком технично»", () => {
    const issues = pipeline.jargonCheck("Сводка теперь в DTO и сохраняется, чтобы не пропадать.", "users");
    assert.deepEqual(issues.map((i) => [i.quote, i.kind]), [["DTO", "jargon"]]);
    assert.match(issues[0].reason, /^слишком технично: /);
    assert.deepEqual(pipeline.jargonCheck("Сводка теперь сохраняется и не пропадает после перезапуска.", "users"), []);
  });

  it("разработчики: термин без объяснения ловится, с «чтобы …» — проходит", () => {
    assert.deepEqual(pipeline.jargonCheck("Добавили отдельный endpoint для запуска.", "dev").map((i) => i.quote), ["endpoint"]);
    assert.deepEqual(pipeline.jargonCheck("Добавили отдельный endpoint, чтобы запуск был доступен только администраторам.", "dev"), []);
    const dense = pipeline.jargonCheck("Endpoint, DTO, repository и snapshot — чтобы было.", "dev");
    assert.ok(dense.some((i) => /слишком плотно/.test(i.reason)));
  });

  it("смешанная: один объяснённый термин можно, два — нет, идентификаторы — нет", () => {
    assert.deepEqual(pipeline.jargonCheck("Сводка теперь хранится в базе, чтобы не пропадать: это сделали через отдельный endpoint, чтобы его можно было защитить.", "mixed"), []);
    assert.equal(pipeline.jargonCheck("Есть endpoint и DTO, чтобы всё работало.", "mixed").length, 2);
    assert.deepEqual(pipeline.jargonCheck("Работает через SnapshotService, чтобы быстрее.", "mixed").map((i) => i.quote), ["SnapshotService"]);
  });

  it("политика терминов — в промпте написания по аудитории", () => {
    assert.match(pipeline.WRITE_SYSTEM({ audience: "users" }), /Термины: Читают пользователи продукта, не программисты\. Никаких названий классов/);
    assert.match(pipeline.WRITE_SYSTEM({ audience: "dev" }), /Термины: Читают разработчики\. Технические термины можно, но каждый объясняй последствием/);
    assert.match(pipeline.WRITE_SYSTEM({ audience: "mixed" }), /не больше одного термина на пост, и его объясни/);
  });

  it("превышение — одна перегенерация с замечанием «слишком технично»; ADMIN из diff — тоже жаргон для пользователей", async () => {
    const calls = [];
    const r = await pipeline.runPipeline({
      data: DATA, variants: 1, profile: { audience: "users" },
      call: fakeAi({ facts: [FACT], calls, text: (req, n) => (n === 1 ? "Сводка для ADMIN\n\nДанные теперь в read model." : "Сводка больше не теряется\n\nОна сохраняется между перезапусками.") }),
    });
    const rewrite = calls.filter((c) => c.step === "write")[1];
    assert.match(rewrite.user, /- «ADMIN»: слишком технично: для пользователей замените человеческими словами/);
    assert.match(rewrite.user, /- «read model»: слишком технично/);
    assert.equal(r.meta.check.regenerated, true);
    assert.deepEqual(r.meta.check.style, []);
  });

  it("если после перегенерации всё ещё технично — замечание остаётся видимым, но публикацию не блокирует", async () => {
    const r = await pipeline.runPipeline({
      data: DATA, variants: 1, profile: { audience: "users" },
      call: fakeAi({ facts: [FACT], text: "Сводка\n\nДанные теперь в read model." }),
    });
    assert.equal(r.status, "draft");
    assert.equal(r.needsReview, false, "подача — не точность");
    assert.deepEqual(r.meta.check.style.map((i) => i.quote), ["read model"]);
  });
});
