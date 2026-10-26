/**
 * Ошибка с HTTP-статусом и машинным кодом: финальный обработчик Express отдаёт их клиенту как есть.
 * Ошибка без статуса считается непредвиденной (500).
 */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };
