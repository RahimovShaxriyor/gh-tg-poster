// Страница /auth/github/create: отправляет форму манифеста на GitHub сразу после загрузки.
// Если шифрование ключей выключено, форма ждёт, пока человек прочитает предупреждение и нажмёт кнопку.
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("manifest-form");
  if (form && form.dataset.auto === "1") form.submit();
});
