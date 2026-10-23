// Фикстура: коммит feat(pms): add durable dashboard persistence.
// Защищённый endpoint запуска bootstrap только для ADMIN; контроллер использует отдельные сервисы
// для snapshot и bootstrap; новые DTO, сущности, репозитории и сервисы read model dashboard.

const SHA = "9c4e2b7d1a3f5e6c8b0d2f4a6c8e0b2d4f6a8c0e";

const DATA = {
  commits: [{ sha: SHA, message: "feat(pms): add durable dashboard persistence" }],
  files: [
    {
      filename: "pms/src/main/java/pms/dashboard/DashboardController.java", additions: 38, deletions: 6,
      patch: [
        "+    private final DashboardSnapshotService snapshotService;",
        "+    private final DashboardBootstrapService bootstrapService;",
        "+    @PreAuthorize(\"hasRole('ADMIN')\")",
        "+    @PostMapping(\"/api/dashboard/bootstrap\")",
        "+    public ResponseEntity<BootstrapResultDto> bootstrap() {",
        "+        return ResponseEntity.ok(bootstrapService.run());",
      ].join("\n"),
    },
    { filename: "pms/src/main/java/pms/dashboard/readmodel/DashboardSnapshotEntity.java", additions: 52, deletions: 0, patch: "+@Entity\n+public class DashboardSnapshotEntity {" },
    { filename: "pms/src/main/java/pms/dashboard/readmodel/DashboardSnapshotRepository.java", additions: 12, deletions: 0, patch: "+public interface DashboardSnapshotRepository extends JpaRepository<DashboardSnapshotEntity, Long> {" },
    { filename: "pms/src/main/java/pms/dashboard/readmodel/DashboardReadModelService.java", additions: 64, deletions: 0, patch: "+public class DashboardReadModelService {" },
    { filename: "pms/src/main/java/pms/dashboard/dto/DashboardSnapshotDto.java", additions: 20, deletions: 0, patch: "+public record DashboardSnapshotDto(" },
  ],
};

// Факты, которые ИИ извлёк бы из этого коммита (ответ шага фактов в моке)
const FACTS = [
  { id: "f1", claim: "Данные сводки на дашборде сохраняются в базе и не теряются при перезапуске сервера", feature: "Сохранение сводки", evidence: [{ sha: "9c4e2b7", file: "pms/src/main/java/pms/dashboard/readmodel/DashboardSnapshotEntity.java" }], user_visible: true, confidence: "high" },
  { id: "f2", claim: "Первичную загрузку данных сводки может запустить только администратор", feature: "Загрузка сводки", evidence: [{ sha: "9c4e2b7", file: "pms/src/main/java/pms/dashboard/DashboardController.java" }], user_visible: true, confidence: "high" },
  { id: "f3", claim: "Снимок сводки и первичная загрузка вынесены в отдельные сервисы", feature: "Устройство сводки", evidence: [{ sha: "9c4e2b7", file: "pms/src/main/java/pms/dashboard/DashboardController.java" }], user_visible: false, confidence: "high" },
];

const ANGLES = [
  { type: "benefit", name: "Польза", hook: "Сводка на дашборде теперь остаётся на месте после перезапуска", idea: "Данные сводки сохраняются" },
  { type: "story", name: "Закулисье", hook: "Как дашборд научился помнить свои данные", idea: "Сводка хранится в базе" },
  { type: "question", name: "Вопрос", hook: "Пропадала ли у вас сводка после перезапуска?", idea: "Вопрос к читателям" },
];

// «До»: сухой пересказ кода — так писал прежний промпт
const DRY = "Добавлена персистентность dashboard\n\nДобавлен защищённый endpoint запуска bootstrap только для ADMIN. Контроллер использует отдельные сервисы DashboardSnapshotService и DashboardBootstrapService. Добавлены новые DTO, сущности, репозитории и сервисы read model.";

// «После» для трёх аудиторий (ответы шага написания в моке)
const AFTER = {
  users: "Сводка на дашборде теперь остаётся на месте после перезапуска\n\nДанные сводки сохраняются в базе, поэтому перезапуск сервера их не стирает.\n\nПервую загрузку данных сводки запускает только администратор.\n\nА что вы смотрите в сводке первым делом?",
  dev: "Сводка на дашборде теперь остаётся на месте после перезапуска\n\nСнимок сводки хранится в базе через отдельную read model, чтобы данные переживали перезапуск сервера.\n\nЗапуск bootstrap закрыт ролью ADMIN, чтобы первичную загрузку не включил случайный пользователь.\n\nА что вы смотрите в сводке первым делом?",
  mixed: "Сводка на дашборде теперь остаётся на месте после перезапуска\n\nДанные сводки сохраняются в базе, поэтому перезапуск сервера их не стирает.\n\nПервичную загрузку (bootstrap) запускает только администратор, чтобы её не включили случайно.\n\nА что вы смотрите в сводке первым делом?",
};

module.exports = { SHA, DATA, FACTS, ANGLES, DRY, AFTER };
