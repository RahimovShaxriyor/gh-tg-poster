/**
 * Анонсы из коммитов — клиент панели. Без зависимостей и без innerHTML:
 * всё, что пришло с сервера (текст ИИ, сообщения коммитов), выводится через textContent.
 */
(() => {
  "use strict";

  // ===== Утилиты =====
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** Создание элемента: h("button", { class: "btn", onclick }, "Текст", child) */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const SVG = "http://www.w3.org/2000/svg";
  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "i");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG, "use");
    use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
  }

  // localStorage может быть недоступен (приватный режим): тогда просто не запоминаем
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  const plural = (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m100 >= 11 && m100 <= 19) return many;
    if (m10 === 1) return one;
    if (m10 >= 2 && m10 <= 4) return few;
    return many;
  };

  // SQLite отдаёт «2026-10-23 04:30:00» в UTC без пометки пояса: без «Z» браузер принял бы это за местное время
  function parseDate(s) {
    if (!s) return null;
    const iso = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(" ", "T") + "Z" : s;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function relShort(s) {
    const d = parseDate(s);
    if (!d) return "";
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "сейчас";
    if (min < 60) return `${min} мин`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours} ч`;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "вчера";
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
  }

  function relLong(s) {
    const short = relShort(s);
    if (!short) return "";
    if (short === "сейчас" || short === "вчера") return short;
    return /мин|ч$/.test(short) ? `${short} назад` : short;
  }

  const fullDate = (s) =>
    parseDate(s)?.toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) || "";
  const clock = (d) => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const isNarrow = () => window.matchMedia("(max-width: 899px)").matches;
  const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  // ===== Состояние =====
  const S = {
    view: "posts",
    filter: "all",
    pageSize: 30,
    posts: [],
    extra: [], // посты сверх первых 100 (кнопка «Показать ещё»)
    counts: {},
    settings: {},
    status: {},
    meta: {},
    loaded: false,
    selectedId: null,
    loginVisible: false,
    checking: false,
    drafts: store.get("gtw.drafts", {}), // несохранённые правки: id -> текст
    saveState: {}, // id -> saving | saved | error
    saveTimers: {},
    dirty: new Set(), // разделы настроек с несохранёнными изменениями
    unmasked: new Set(),
    repos: null,
    reposError: "",
    lastDetailKey: "",
    pollTimer: null,
    pendingRegen: new Set(),
  };

  const STATUS = {
    draft: { label: "Черновик", dot: "is-accent" },
    generating: { label: "Пишется", dot: "is-accent" },
    sending: { label: "Отправляется", dot: "is-accent" },
    sent: { label: "Отправлен", dot: "is-ok" },
    failed: { label: "Ошибка", dot: "is-error" },
    skipped: { label: "Пропущен", dot: "" },
    rejected: { label: "Отклонён", dot: "" },
  };

  const allPosts = () => [...S.posts, ...S.extra];
  const findPost = (id) => allPosts().find((p) => p.id === id);
  const persistDrafts = () => store.set("gtw.drafts", S.drafts);

  // ===== Запросы =====
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, { method = "GET", body } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new ApiError("Нет связи с сервером. Проверьте интернет и повторите.", 0);
    }
    if (res.status === 401 && path !== "/login") {
      showLogin(true);
      throw new ApiError("Сессия истекла. Войдите снова, затем повторите действие.", 401);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Ошибка сервера (${res.status})`, res.status, data);
    return data;
  }

  /** Кнопка блокируется на время запроса, повторный клик игнорируется */
  async function busy(btn, fn) {
    if (btn?.disabled) return undefined;
    if (btn) {
      btn.disabled = true;
      btn.classList.add("is-busy");
    }
    try {
      return await fn();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("is-busy");
      }
    }
  }

  function toast(message, kind = "ok") {
    const el = h("div", { class: "toast" + (kind === "error" ? " is-error" : ""), role: kind === "error" ? "alert" : "status" }, message);
    $("#toasts").append(el);
    setTimeout(() => el.remove(), kind === "error" ? 7000 : 4000);
  }

  const fail = (err) => {
    if (err?.status !== 401) toast(err.message, "error");
  };

  // ===== Диалог подтверждения (вместо confirm()) =====
  function confirmDialog({ title, text, ok, danger = true }) {
    const dlg = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    const okBtn = $("#confirm-ok");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    dlg.returnValue = "cancel";
    dlg.showModal();
    $("#confirm-cancel").focus();
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    });
  }

  // ===== Вход и потеря сессии =====
  function showLogin(expired) {
    stopPolling();
    $("#login-note").textContent = expired
      ? "Сессия истекла. Войдите снова: введённый текст сохранён и вернётся на место."
      : "Введите пароль администратора.";
    if (S.loginVisible) return; // не трогаем поле, если человек уже вводит пароль
    S.loginVisible = true;
    $("#login").hidden = false;
    $("#app").setAttribute("aria-hidden", "true");
    $("#login-error").hidden = true;
    $("#pw").value = "";
    $("#pw").focus();
  }

  function hideLogin() {
    S.loginVisible = false;
    $("#login").hidden = true;
    $("#app").removeAttribute("aria-hidden");
  }

  async function onLogin(e) {
    e.preventDefault();
    const pw = $("#pw");
    const errEl = $("#login-error");
    if (!pw.value) {
      errEl.textContent = "Введите пароль.";
      errEl.hidden = false;
      return;
    }
    await busy($("#login-submit"), async () => {
      try {
        await api("/login", { method: "POST", body: { password: pw.value } });
        pw.value = "";
        hideLogin();
        await loadState();
        flushSaves();
      } catch (err) {
        errEl.textContent = err.status === 401 ? "Неверный пароль." : err.message;
        errEl.hidden = false;
        pw.select();
      }
    });
  }

  async function onLogout() {
    try {
      await api("/logout", { method: "POST" });
    } catch {}
    showLogin(false);
  }

  // ===== Загрузка состояния и опрос =====
  async function loadState() {
    const limit = Math.min(S.pageSize, 100);
    const query = new URLSearchParams({ limit, offset: 0, filter: S.filter, tzo: new Date().getTimezoneOffset() });
    try {
      const data = await api("/api/state?" + query);
      hideLogin();
      S.settings = data.settings || {};
      S.status = data.status || {};
      S.counts = data.counts || {};
      S.meta = {
        domain: data.domain,
        encryption: data.encryption_enabled,
        appId: data.github_app_id,
        appSlug: data.github_app_slug,
        appSource: data.github_app_source,
        appBaseUrl: data.github_app_base_url,
        publicUrl: data.public_url,
        installationId: data.github_installation_id,
        accountLogin: data.github_account_login,
        hasGithub: data.has_github_token,
        nextPollIn: data.next_poll_in,
        debounceUntil: data.debounce_until,
        total: data.pagination?.total ?? 0,
      };
      S.posts = data.posts || [];
      const ids = new Set(S.posts.map((p) => p.id));
      S.extra = S.extra.filter((p) => !ids.has(p.id));
      S.loaded = true;
      dropStaleDrafts();
      render();
    } catch (err) {
      if (err.status !== 401) {
        $("#status-line").replaceChildren(h("span", { class: "is-error" }, err.message));
      }
    } finally {
      schedulePoll();
    }
  }

  function schedulePoll() {
    stopPolling();
    if (S.loginVisible) return;
    // Пока ИИ пишет или пост отправляется — обновляем чаще
    const active = S.checking || allPosts().some((p) => p.status === "generating" || p.status === "sending");
    S.pollTimer = setTimeout(() => {
      if (!document.hidden) loadState();
      else schedulePoll();
    }, active ? 3000 : 30000);
  }

  function stopPolling() {
    clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }

  async function loadMore(btn) {
    await busy(btn, async () => {
      if (S.pageSize < 100) {
        S.pageSize = Math.min(S.pageSize + 30, 100);
        await loadState();
        return;
      }
      const offset = allPosts().length;
      const query = new URLSearchParams({ limit: 100, offset, filter: S.filter, tzo: new Date().getTimezoneOffset() });
      try {
        const data = await api("/api/state?" + query);
        S.extra.push(...(data.posts || []));
        renderList();
      } catch (err) {
        fail(err);
      }
    });
  }

  // Правки для постов, которые больше не черновики, не нужны
  function dropStaleDrafts() {
    let changed = false;
    for (const id of Object.keys(S.drafts)) {
      const p = findPost(Number(id));
      if (p && p.status !== "draft") {
        delete S.drafts[id];
        changed = true;
      }
    }
    if (changed) persistDrafts();
  }

  // ===== Маршруты: #posts, #posts/12, #settings, #settings/telegram =====
  function applyRoute() {
    const [view, arg] = location.hash.replace(/^#/, "").split("/");
    S.view = view === "settings" ? "settings" : "posts";
    if (S.view === "posts") {
      const id = Number(arg);
      S.selectedId = Number.isInteger(id) && id > 0 ? id : null;
    }
    closePopover();
    render();
    if (S.view === "settings") {
      ensureRepos();
      if (arg) $(`#sec-${arg}`)?.scrollIntoView({ block: "start" });
      else window.scrollTo(0, 0);
    }
  }

  function selectPost(id, { replace = false, focus = false } = {}) {
    const hash = id ? `#posts/${id}` : "#posts";
    if (replace) {
      history.replaceState(null, "", hash);
      S.selectedId = id;
      render();
    } else if (location.hash !== hash) {
      location.hash = hash;
    } else {
      render();
    }
    if (focus) $("#detail").focus({ preventScroll: true });
  }

  // ===== Отрисовка =====
  function render() {
    $("#view-posts").hidden = S.view !== "posts";
    $("#view-settings").hidden = S.view !== "settings";
    for (const a of $$(".view-link")) {
      if (a.dataset.view === S.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const drafts = S.counts.draft || 0;
    $("#nav-drafts").textContent = drafts ? String(drafts) : "";
    document.title = drafts ? `(${drafts}) Анонсы из коммитов` : "Анонсы из коммитов";

    renderConn();
    if (S.view === "posts") {
      renderStatusLine();
      renderFilters();
      renderList();
      renderDetail();
    } else {
      renderSettings();
    }
  }

  // --- Подключения в шапке ---
  function connInfo(kind) {
    const s = S.settings;
    const err = S.status.last_error || "";
    if (kind === "github") {
      if (!S.meta.hasGithub && S.meta.appId) return { state: "is-warn", title: "Осталось выбрать репозитории", text: "Приложение GitHub создано. В настройках нажмите «Выбрать репозитории»." };
      if (!S.meta.hasGithub) return { state: "", title: "GitHub не подключён", text: "В настройках нажмите «Подключить GitHub»." };
      if (!s.repo) return { state: "is-warn", title: "Репозиторий не выбран", text: "GitHub подключён. Выберите репозиторий в настройках." };
      if (err) return { state: "is-error", title: "Проверка GitHub не удалась", text: err };
      const when = S.status.last_check ? `Последняя проверка ${relLong(S.status.last_check)}.` : "Проверок ещё не было.";
      return { state: "is-ok", title: `${s.repo}, ветка ${s.branch || "main"}`, text: when };
    }
    if (kind === "telegram") {
      if (s.tg_token_corrupted) return { state: "is-error", title: "Токен бота не расшифровывается", text: "Сменился ENCRYPTION_KEY. Введите токен заново." };
      if (!s.tg_token_set) return { state: "", title: "Бот не подключён", text: "Добавьте токен бота в настройках." };
      if (!s.channel_id) return { state: "is-warn", title: "Канал не выбран", text: "Укажите канал или добавьте бота администратором в канал." };
      if (!s.tg_owner_chat_id) {
        return { state: "is-warn", title: `Канал ${s.channel_id}`, text: "Вы не привязаны как владелец: черновики в личку и команды /check, /status не работают." };
      }
      return { state: "is-ok", title: `Канал ${s.channel_id}`, text: `Владелец: ${s.tg_owner_username || s.tg_owner_chat_id}. В личке работают /check и /status.` };
    }
    if (s.ai_key_corrupted) return { state: "is-error", title: "Ключ ИИ не расшифровывается", text: "Сменился ENCRYPTION_KEY. Введите ключ заново." };
    if (!s.ai_key_set || !s.ai_model) return { state: "", title: "ИИ не настроен", text: "Добавьте ключ и модель в настройках." };
    return { state: "is-ok", title: `${s.ai_provider === "openai" ? "OpenAI" : "Anthropic"}: ${s.ai_model}`, text: "Ключ сохранён." };
  }

  function renderConn() {
    for (const kind of ["github", "telegram", "ai"]) {
      const info = S.loaded ? connInfo(kind) : { state: "", title: "" };
      const dot = $(`[data-dot="${kind}"]`);
      dot.className = "dot " + info.state;
      const btn = dot.closest("button");
      btn.title = info.title;
      btn.setAttribute("aria-label", `${btn.textContent.trim()}: ${info.title || "загрузка"}`);
    }
    if (!$("#conn-popover").hidden) fillPopover($("#conn-popover").dataset.kind);
  }

  function openPopover(kind, btn) {
    const pop = $("#conn-popover");
    if (!pop.hidden && pop.dataset.kind === kind) return closePopover();
    closePopover();
    pop.dataset.kind = kind;
    $("#pop-result").hidden = true;
    fillPopover(kind);
    pop.hidden = false;
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth;
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
    btn.setAttribute("aria-expanded", "true");
    $("#pop-test").focus();
  }

  function fillPopover(kind) {
    const info = connInfo(kind);
    $("#pop-title").textContent = info.title;
    $("#pop-text").textContent = info.text;
  }

  function closePopover() {
    const pop = $("#conn-popover");
    if (pop.hidden) return;
    pop.hidden = true;
    const btn = $(`.conn-btn[data-conn="${pop.dataset.kind}"]`);
    btn?.setAttribute("aria-expanded", "false");
  }

  async function testConnection(kind, resultEl, btn) {
    await busy(btn, async () => {
      resultEl.hidden = false;
      resultEl.className = resultEl.className.replace(/ ?is-(ok|error)/g, "");
      resultEl.textContent = "Проверяю…";
      try {
        const res = await api(`/api/test/${kind}`, { method: "POST" });
        resultEl.textContent = res.message || "Подключение работает.";
        resultEl.classList.add("is-ok");
      } catch (err) {
        resultEl.textContent = err.message;
        resultEl.classList.add("is-error");
      }
    });
  }

  // --- Строка состояния над списком ---
  function renderStatusLine() {
    const line = $("#status-line");
    if (!S.loaded) return;
    const parts = [];
    const st = S.status;
    if (st.last_error) {
      parts.push(h("button", { type: "button", class: "link-btn is-error", onclick: (e) => openPopover("github", $('.conn-btn[data-conn="github"]'), e) }, "Проверка GitHub не удалась"));
    } else if (st.last_check) {
      parts.push(h("span", {}, `Проверено ${relLong(st.last_check)}`));
    } else {
      parts.push(h("span", {}, "Проверок ещё не было"));
    }
    if (S.meta.debounceUntil && st.minutes_left > 0) {
      parts.push(h("span", {}, `пост через ${st.minutes_left} мин`));
    } else if (S.meta.nextPollIn !== null && S.meta.nextPollIn !== undefined) {
      parts.push(h("span", {}, S.meta.nextPollIn > 0 ? `следующая через ${S.meta.nextPollIn} мин` : "следующая меньше чем через минуту"));
    }
    if (S.counts.sent_today) parts.push(h("span", {}, `сегодня отправлено ${S.counts.sent_today}`));
    const withSeparators = parts.flatMap((p, i) => (i ? [h("span", { "aria-hidden": "true" }, "·"), p] : [p]));
    line.replaceChildren(...withSeparators);
  }

  function renderFilters() {
    for (const btn of $$(".filter")) {
      btn.setAttribute("aria-selected", String(btn.dataset.filter === S.filter));
    }
    for (const c of $$("[data-count]")) {
      const n = S.counts[c.dataset.count];
      c.textContent = S.loaded && n ? String(n) : "";
    }
  }

  // --- Список постов ---
  function postTitle(p) {
    const text = (S.drafts[p.id] ?? p.text ?? "").trim();
    if (text) return text.split("\n")[0];
    const commits = parseCommits(p);
    return commits[0]?.message || "Без текста";
  }

  function parseCommits(p) {
    try {
      const list = JSON.parse(p.commits || "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function renderList() {
    const list = $("#post-list");
    const empty = $("#list-empty");
    if (!S.loaded) {
      list.replaceChildren(...Array.from({ length: 6 }, () => h("li", { class: "skeleton-row", "aria-hidden": "true" },
        h("span", { class: "skeleton skeleton-text" }), h("span", { class: "skeleton skeleton-text" }))));
      empty.hidden = true;
      return;
    }

    const posts = allPosts();
    list.replaceChildren(...posts.map((p) => {
      const st = STATUS[p.status] || { label: p.status, dot: "" };
      const commits = parseCommits(p);
      const meta = [`#${p.id}`, st.label];
      if (commits.length) meta.push(`${commits.length} ${plural(commits.length, "коммит", "коммита", "коммитов")}`);
      if (S.drafts[p.id] !== undefined && p.status === "draft") meta.push("есть правки");
      const muted = p.status === "skipped" || p.status === "rejected";
      return h("li", {
        class: "post-item" + (muted ? " is-muted" : ""),
        role: "button",
        tabindex: "0",
        "aria-selected": String(p.id === S.selectedId),
        dataset: { id: p.id },
        onclick: () => selectPost(p.id),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectPost(p.id, { focus: true });
          }
        },
      },
      h("span", { class: "dot " + st.dot, "aria-hidden": "true" }),
      h("span", { class: "pi-title" }, postTitle(p)),
      h("time", { class: "pi-time", datetime: parseDate(p.created_at)?.toISOString(), title: fullDate(p.created_at) }, relShort(p.created_at)),
      h("span", { class: "pi-meta" }, meta.join(" · ")));
    }));

    $("#list-more").hidden = posts.length >= (S.meta.total || 0);

    if (posts.length) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    empty.replaceChildren(...emptyState());
  }

  function setupSteps() {
    const s = S.settings;
    return [
      { done: S.meta.hasGithub && !!s.repo, text: "GitHub и репозиторий", section: "github" },
      { done: s.tg_token_set && !!s.channel_id, text: "Бот и канал в Telegram", section: "telegram" },
      { done: s.ai_key_set && !!s.ai_model, text: "Ключ и модель ИИ", section: "ai" },
      { done: !!s.tg_owner_chat_id, text: "Привязка владельца к боту", section: "telegram" },
    ];
  }

  function emptyState() {
    if (S.filter !== "all") {
      return [
        h("p", { class: "empty-title" }, "Здесь пусто"),
        h("p", { class: "empty-text" }, "В этом фильтре нет постов."),
        h("button", { type: "button", class: "btn btn-secondary", onclick: () => setFilter("all") }, "Показать все"),
      ];
    }
    const steps = setupSteps();
    if (steps.some((st) => !st.done)) {
      return [
        h("p", { class: "empty-title" }, "Настройте подключения"),
        h("p", { class: "empty-text" }, "После этого панель начнёт следить за коммитами и готовить черновики."),
        h("ol", { class: "setup-list" }, steps.map((st) => h("li", { class: st.done ? "is-done" : "" },
          h("span", {}, st.text),
          st.done ? null : h("a", { class: "btn btn-secondary btn-sm", href: `#settings/${st.section}` }, "Настроить")))),
      ];
    }
    return [
      icon("inbox"),
      h("p", { class: "empty-title" }, "Постов пока нет"),
      h("p", { class: "empty-text" }, `Когда в ${S.settings.repo} появятся новые коммиты, здесь будет черновик. Можно проверить прямо сейчас.`),
      h("button", { type: "button", class: "btn btn-primary", onclick: (e) => runCheck(e.currentTarget) }, "Проверить сейчас"),
    ];
  }

  function setFilter(filter) {
    S.filter = filter;
    S.pageSize = 30;
    S.extra = [];
    renderFilters();
    loadState();
  }

  // --- Выбранный пост ---
  function renderDetail() {
    const pane = $("#detail");
    const view = $("#view-posts");

    if (!S.loaded) {
      pane.replaceChildren(h("div", { class: "detail", "aria-hidden": "true" },
        h("span", { class: "skeleton skeleton-text" }), h("span", { class: "skeleton skeleton-text" }),
        h("div", { class: "block" }), h("span", { class: "skeleton skeleton-block" })));
      view.classList.remove("has-selection");
      return;
    }

    // На широком экране без выбора открываем первый черновик или первый пост
    if (!S.selectedId && !isNarrow()) {
      const first = S.posts.find((p) => p.status === "draft") || S.posts[0];
      if (first) {
        history.replaceState(null, "", `#posts/${first.id}`);
        S.selectedId = first.id;
        renderList();
      }
    }

    const p = S.selectedId ? findPost(S.selectedId) : null;
    view.classList.toggle("has-selection", !!S.selectedId);
    if (!p) {
      S.lastDetailKey = "";
      pane.replaceChildren(h("div", { class: "detail-placeholder" },
        S.selectedId ? "Пост не найден: его удалили или он в другом фильтре." : allPosts().length ? "Выберите пост слева." : ""));
      return;
    }

    // Не перестраиваем редактор, если пост не изменился: иначе пропал бы фокус и курсор
    const key = [p.id, p.status, p.error, p.interrupted, p.tg_message_id, S.drafts[p.id] !== undefined ? "local" : p.text, S.pendingRegen.has(p.id)].join("|");
    if (key === S.lastDetailKey && pane.firstChild) {
      updateSaveState(p.id);
      return;
    }
    S.lastDetailKey = key;
    pane.replaceChildren(detailView(p));
  }

  function detailView(p) {
    const st = STATUS[p.status] || { label: p.status, dot: "" };
    const generating = p.status === "generating" || S.pendingRegen.has(p.id);
    const root = h("article", { class: "detail", "aria-labelledby": "detail-title" });

    root.append(h("button", { type: "button", class: "btn btn-ghost detail-back", onclick: () => selectPost(null) }, icon("back"), "Все посты"));

    root.append(h("header", { class: "detail-head" },
      h("h1", { class: "detail-title", id: "detail-title" }, `${p.kind === "digest" ? "Дайджест" : "Пост"} #${p.id}`),
      h("span", { class: "badge" }, h("span", { class: "dot " + st.dot, "aria-hidden": "true" }), generating ? "Пишется" : st.label),
      h("time", { class: "detail-meta", datetime: parseDate(p.created_at)?.toISOString(), title: fullDate(p.created_at) }, `создан ${relLong(p.created_at)}`)));

    for (const n of notices(p)) root.append(n);

    const commits = parseCommits(p);
    if (commits.length) {
      const repo = S.settings.repo;
      root.append(h("section", { class: "block" },
        h("h2", { class: "block-title" }, `Коммиты · ${commits.length}`),
        h("ul", { class: "commits" }, commits.map((c) => h("li", {},
          repo ? h("a", { class: "commit-sha", href: `https://github.com/${repo}/commit/${c.sha}`, target: "_blank", rel: "noopener noreferrer" }, c.sha.slice(0, 7))
            : h("span", { class: "commit-sha" }, c.sha.slice(0, 7)),
          h("span", { class: "commit-msg", title: c.message }, c.message),
          h("time", { class: "commit-time", datetime: c.date, title: fullDate(c.date) }, relShort(c.date)))))));
    }

    if (generating) {
      root.append(h("section", { class: "block" },
        h("h2", { class: "block-title" }, "Текст поста"),
        h("p", { class: "hint" }, "ИИ пишет текст. Обычно это занимает до минуты, страница обновится сама."),
        h("span", { class: "skeleton skeleton-block", "aria-hidden": "true" })));
      return root;
    }

    if (p.status === "draft") {
      root.append(editorBlock(p));
      root.append(previewBlock(p, () => currentText(p)));
      root.append(draftActions(p));
      return root;
    }

    if (p.text || p.status === "sent") root.append(previewBlock(p, () => p.text || ""));
    root.append(otherActions(p));
    return root;
  }

  function notices(p) {
    const out = [];
    const notice = (kind, ic, title, text) =>
      h("div", { class: "notice " + kind, role: kind === "is-error" ? "alert" : null }, icon(ic), h("div", {}, h("p", {}, title), text ? h("p", {}, text) : null));
    if (p.status === "failed" && p.interrupted) {
      out.push(notice("is-warn", "alert", "Отправка прервалась: пост мог уже появиться в канале.", "Проверьте канал, прежде чем отправлять снова."));
      if (p.error && !p.error.startsWith("Отправка прервана")) out.push(notice("is-error", "alert", p.error));
    } else if (p.status === "failed") {
      out.push(notice("is-error", "alert", p.error || "Не получилось.", p.text ? "Исправьте причину и отправьте снова или попросите ИИ написать другой вариант." : "Попросите ИИ написать пост заново."));
    } else if (p.status === "draft" && p.error) {
      out.push(notice("is-warn", "alert", p.error));
    } else if (p.status === "skipped") {
      out.push(notice("", "info", "ИИ решил, что подписчикам эти изменения неинтересны.", "Если не согласны, попросите написать пост всё равно."));
    } else if (p.status === "rejected" && p.error) {
      out.push(notice("", "info", p.error));
    }
    return out;
  }

  const currentText = (p) => S.drafts[p.id] ?? p.text ?? "";

  function editorBlock(p) {
    const textarea = h("textarea", { class: "editor", id: "editor", "aria-describedby": "editor-foot", spellcheck: "true" });
    textarea.value = currentText(p);
    const counter = h("span", { class: "mono", id: "editor-count" });
    const saveEl = h("span", { id: "editor-save" });

    const sync = () => {
      const len = textarea.value.length;
      counter.textContent = `${len} / 4096`;
      counter.classList.toggle("is-over", len > 4096);
      textarea.classList.toggle("is-over", len > 4096);
      const preview = $("#preview-text");
      if (preview) fillPreviewText(preview, textarea.value);
    };

    textarea.addEventListener("input", () => {
      S.drafts[p.id] = textarea.value;
      persistDrafts();
      sync();
      autosize(textarea);
      scheduleSave(p.id);
    });
    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        $("#btn-publish")?.click();
      }
    });
    requestAnimationFrame(() => autosize(textarea));
    sync();

    const block = h("section", { class: "block" },
      h("h2", { class: "block-title" }, h("label", { for: "editor" }, "Текст поста"), saveEl),
      textarea,
      h("div", { class: "editor-foot", id: "editor-foot" }, h("span", {}, "Ctrl+Enter — опубликовать"), counter));
    requestAnimationFrame(() => updateSaveState(p.id));
    return block;
  }

  function autosize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight + 2, 160), 640)}px`;
  }

  function updateSaveState(id) {
    const el = $("#editor-save");
    if (!el) return;
    const state = S.saveState[id];
    const labels = { saving: "Сохраняю…", saved: "Сохранено", error: "Не сохранено: нет связи" };
    el.textContent = S.drafts[id] !== undefined && !state ? "Есть несохранённые правки" : labels[state] || "";
    el.className = state === "error" ? "is-error" : "";
  }

  // Правка уходит на сервер через 0,8 с после остановки набора
  function scheduleSave(id) {
    clearTimeout(S.saveTimers[id]);
    S.saveState[id] = "saving";
    updateSaveState(id);
    S.saveTimers[id] = setTimeout(() => saveDraft(id), 800);
  }

  async function saveDraft(id) {
    const text = S.drafts[id];
    if (text === undefined) return;
    try {
      await api(`/api/posts/${id}/text`, { method: "POST", body: { text } });
      const p = findPost(id);
      if (p) p.text = text;
      if (S.drafts[id] === text) {
        delete S.drafts[id];
        persistDrafts();
        S.saveState[id] = "saved";
        S.lastDetailKey = "";
      }
    } catch (err) {
      if (err.status === 409) {
        delete S.drafts[id];
        persistDrafts();
        delete S.saveState[id];
        toast("Пост уже не черновик: правка не сохранена.", "error");
        loadState();
        return;
      }
      S.saveState[id] = "error";
    }
    updateSaveState(id);
  }

  function flushSaves() {
    for (const id of Object.keys(S.drafts)) saveDraft(Number(id));
  }

  // --- Предпросмотр как в Telegram ---
  function fillPreviewText(el, text) {
    el.classList.toggle("is-empty", !text.trim());
    if (!text.trim()) {
      el.textContent = "Пустое сообщение";
      return;
    }
    // Ссылки Telegram подсвечивает сам: повторяем это, ничего не превращая в HTML
    const parts = text.split(/(https?:\/\/[^\s<>"«»]+)/g);
    el.replaceChildren(...parts.map((part, i) => (i % 2 ? h("span", { class: "tg-link" }, part) : part)));
  }

  function previewBlock(p, getText) {
    const channel = S.settings.channel_id || "";
    const name = channel.startsWith("@") ? channel.slice(1) : "Ваш канал";
    const sentAt = parseDate(p.sent_at);
    const textEl = h("div", { class: "tg-text", id: p.status === "draft" ? "preview-text" : null });
    fillPreviewText(textEl, getText());
    return h("section", { class: "block", "aria-label": "Предпросмотр" },
      h("h2", { class: "block-title" }, p.status === "sent" ? "Так выглядит в канале" : "Так увидят подписчики",
        p.status === "sent" && sentAt ? h("time", { class: "detail-meta", datetime: sentAt.toISOString() }, `отправлен ${fullDate(p.sent_at)}`) : null),
      h("div", { class: "tg" }, h("div", { class: "tg-post" },
        h("span", { class: "tg-avatar", "aria-hidden": "true" }, name.charAt(0)),
        h("div", { class: "tg-bubble" },
          h("div", { class: "tg-name" }, name),
          textEl,
          h("div", { class: "tg-meta" }, h("time", {}, clock(sentAt || new Date())))))));
  }

  // --- Действия ---
  function draftActions(p) {
    const publishBtn = h("button", { type: "button", class: "btn btn-primary", id: "btn-publish", onclick: (e) => doPublish(p, e.currentTarget) },
      "Опубликовать", h("span", { class: "kbd-hint" }, "Ctrl+Enter"));
    return h("div", { class: "actions is-sticky" },
      publishBtn,
      h("button", { type: "button", class: "btn btn-secondary", onclick: (e) => doRegen(p, e.currentTarget) }, "Другой вариант"),
      h("button", { type: "button", class: "btn btn-secondary", onclick: (e) => doReject(p, e.currentTarget) }, "Отклонить"),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-ghost danger-text", onclick: (e) => doDelete(p, e.currentTarget) }, icon("trash"), "Удалить"));
  }

  function otherActions(p) {
    const row = h("div", { class: "actions" });
    const add = (...els) => row.append(...els);
    if (p.status === "sent") {
      const link = channelLink(p);
      if (link) add(h("a", { class: "btn btn-secondary", href: link, target: "_blank", rel: "noopener noreferrer" }, "Открыть в канале", icon("external")));
      if (p.tg_message_id) add(h("button", { type: "button", class: "btn btn-ghost danger-text", onclick: (e) => doDeleteFromChannel(p, e.currentTarget) }, "Удалить из канала"));
    }
    if (p.status === "failed") {
      if (p.text) add(h("button", { type: "button", class: "btn btn-primary", onclick: (e) => doRetry(p, e.currentTarget) }, "Отправить снова"));
      add(h("button", { type: "button", class: "btn btn-secondary", onclick: (e) => doRegen(p, e.currentTarget) }, p.text ? "Другой вариант" : "Написать заново"));
      add(h("button", { type: "button", class: "btn btn-secondary", onclick: (e) => doReject(p, e.currentTarget) }, "Отклонить"));
    }
    if (p.status === "skipped") {
      add(h("button", { type: "button", class: "btn btn-primary", onclick: (e) => doRegen(p, e.currentTarget) }, "Всё равно написать"));
      add(h("button", { type: "button", class: "btn btn-secondary", onclick: (e) => doReject(p, e.currentTarget) }, "Отклонить"));
    }
    if (p.status === "rejected") {
      add(h("button", { type: "button", class: "btn btn-secondary", onclick: (e) => doRegen(p, e.currentTarget) }, "Написать заново"));
    }
    if (p.status !== "sending") {
      add(h("span", { class: "spacer" }));
      add(h("button", { type: "button", class: "btn btn-ghost danger-text", onclick: (e) => doDelete(p, e.currentTarget) }, icon("trash"), "Удалить из истории"));
    }
    return row;
  }

  function channelLink(p) {
    const ch = S.settings.channel_id || "";
    if (!p.tg_message_id) return "";
    if (ch.startsWith("@")) return `https://t.me/${ch.slice(1)}/${p.tg_message_id}`;
    if (/^-100\d+$/.test(ch)) return `https://t.me/c/${ch.slice(4)}/${p.tg_message_id}`;
    return "";
  }

  async function doPublish(p, btn) {
    const text = ($("#editor")?.value ?? currentText(p)).trim();
    if (!text) return toast("Текст пустой: напишите пост или попросите другой вариант.", "error");
    if (text.length > 4096) return toast(`Текст длиннее 4096 символов на ${text.length - 4096}. Сократите его.`, "error");
    clearTimeout(S.saveTimers[p.id]);
    await busy(btn, async () => {
      try {
        await api(`/api/posts/${p.id}/publish`, { method: "POST", body: { text } });
        delete S.drafts[p.id];
        persistDrafts();
        toast("Опубликовано в канал.");
        await loadState();
      } catch (err) {
        fail(err);
        await loadState();
      }
    });
  }

  async function doRetry(p, btn) {
    if (p.interrupted) {
      const ok = await confirmDialog({
        title: "Отправить ещё раз?",
        text: "Прошлая отправка прервалась, и пост мог уже появиться в канале. Отправляйте, только если в канале его нет.",
        ok: "Отправить",
        danger: false,
      });
      if (!ok) return;
    }
    await busy(btn, async () => {
      try {
        await api(`/api/posts/${p.id}/publish`, { method: "POST", body: {} });
        toast("Опубликовано в канал.");
      } catch (err) {
        fail(err);
      }
      await loadState();
    });
  }

  async function doRegen(p, btn) {
    if (S.drafts[p.id] !== undefined || (p.status === "draft" && $("#editor") && $("#editor").value !== (p.text || ""))) {
      const ok = await confirmDialog({ title: "Заменить текст?", text: "Новый вариант заменит ваши правки.", ok: "Заменить" });
      if (!ok) return;
    }
    clearTimeout(S.saveTimers[p.id]);
    delete S.drafts[p.id];
    persistDrafts();
    S.pendingRegen.add(p.id);
    renderDetail();
    renderList();
    await busy(btn, async () => {
      try {
        const res = await api(`/api/posts/${p.id}/regen`, { method: "POST" });
        if (res.status === "skipped") toast("ИИ снова решил, что это неинтересно.");
      } catch (err) {
        fail(err);
      } finally {
        S.pendingRegen.delete(p.id);
      }
      await loadState();
    });
  }

  async function doReject(p, btn) {
    await busy(btn, async () => {
      try {
        await api(`/api/posts/${p.id}/reject`, { method: "POST" });
        delete S.drafts[p.id];
        persistDrafts();
        toast(`Пост #${p.id} отклонён.`);
        await loadState();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function doDelete(p, btn) {
    const ok = await confirmDialog({
      title: `Удалить пост #${p.id} из истории?`,
      text: p.status === "sent" ? "Запись исчезнет из панели. Сообщение в канале останется." : "Запись исчезнет из панели. Это нельзя отменить.",
      ok: "Удалить",
    });
    if (!ok) return;
    await busy(btn, async () => {
      try {
        await api(`/api/posts/${p.id}`, { method: "DELETE" });
        delete S.drafts[p.id];
        persistDrafts();
        toast(`Пост #${p.id} удалён из истории.`);
        selectPost(null, { replace: true });
        await loadState();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function doDeleteFromChannel(p, btn) {
    const ok = await confirmDialog({
      title: "Удалить сообщение из канала?",
      text: "Подписчики больше не увидят этот пост. Запись в панели останется со статусом «Отклонён».",
      ok: "Удалить из канала",
    });
    if (!ok) return;
    await busy(btn, async () => {
      try {
        await api(`/api/posts/${p.id}/delete-from-channel`, { method: "POST" });
        toast("Сообщение удалено из канала.");
        await loadState();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function runCheck(btn) {
    S.checking = true;
    await busy(btn, async () => {
      try {
        const res = await api("/api/check", { method: "POST" });
        toast(res.message || "Проверка выполнена.");
        await loadState();
        const created = res.posts?.[0]?.id;
        if (created) selectPost(created);
      } catch (err) {
        fail(err);
        await loadState();
      } finally {
        S.checking = false;
      }
    });
  }

  // ===== Настройки =====
  const MODELS = {
    anthropic: { list: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"], hint: "Для коротких постов хватает claude-haiku-5-5: быстрее и дешевле." },
    openai: { list: ["gpt-4o-mini", "gpt-4o"], hint: "Название модели из кабинета OpenAI." },
  };

  function renderSettings() {
    if (!S.loaded) return;
    const s = S.settings;
    const fill = (section, fn) => {
      if (!S.dirty.has(section)) fn();
    };

    renderGithubConnect();
    fill("github", () => {
      // Ручной токен раскрыт, если он уже используется вместо приложения
      $("#gh-manual").open = !!s.github_token_set && !S.meta.installationId;
      secretField("github_token", s.github_token_set, s.github_token_corrupted);
      $("#branch").value = s.branch || "main";
      fillRepoSelect();
    });

    fill("telegram", () => {
      secretField("tg_token", s.tg_token_set, s.tg_token_corrupted);
      $("#channel_id").value = s.channel_id || "";
      $("#tg_notify_drafts").checked = s.tg_notify_drafts === "1";
    });
    $("#owner-status").textContent = s.tg_owner_chat_id
      ? `${s.tg_owner_username || "Владелец"} (ID ${s.tg_owner_chat_id})`
      : "Не привязан. Получите код и отправьте его боту в личку.";
    $("#btn-owner-reset").hidden = !s.tg_owner_chat_id;

    fill("ai", () => {
      $("#ai_provider").value = s.ai_provider || "anthropic";
      secretField("ai_key", s.ai_key_set, s.ai_key_corrupted);
      $("#ai_model").value = s.ai_model || "";
      updateModelHints();
    });

    fill("behavior", () => {
      $("#mode").value = s.mode || "approve";
      $("#digest_time").value = s.digest_time || "18:00";
      $("#digest_tz").value = s.digest_tz || "Europe/Moscow";
      $("#poll_interval").value = s.poll_interval || "5";
      $("#debounce").value = s.debounce || "10";
      $("#tone").value = s.tone || "";
      $("#digest-fields").hidden = $("#mode").value !== "digest";
    });

    $("#enc-status").textContent = S.meta.encryption
      ? "Токены и ключи хранятся в базе в зашифрованном виде (AES-256-GCM, ключ ENCRYPTION_KEY)."
      : "ENCRYPTION_KEY не задан: токены и ключи хранятся в базе открытым текстом. Задайте ключ в .env и перезапустите сервер.";

    const current = location.hash.split("/")[1] || "github";
    for (const a of $$(".settings-link")) a.setAttribute("aria-current", String(a.dataset.section === current));
  }

  // Раздел GitHub: «не подключено» → «приложение создано, выберите репозитории» → «подключено»
  function renderGithubConnect() {
    const m = S.meta;
    const stage = m.installationId ? "connected" : m.appId ? "app" : "none";
    const show = (id, on) => {
      $(id).hidden = !on;
    };
    show("#gh-connect-btn", stage === "none");
    show("#gh-install-btn", stage === "app");
    show("#gh-manage", stage === "connected");
    show("#gh-recreate", stage !== "none");
    show("#gh-disconnect", stage !== "none");

    if (stage === "none") {
      $("#gh-status").textContent = "Не подключено.";
      $("#gh-hint").textContent = "GitHub попросит один раз подтвердить создание приложения. Права только на чтение выбранных репозиториев.";
    } else if (stage === "app") {
      $("#gh-status").textContent = `Приложение «${m.appSlug || m.appId}» создано, осталось выбрать репозитории.`;
      $("#gh-hint").textContent = "GitHub откроет страницу установки: отметьте репозиторий с проектом и нажмите Install.";
    } else {
      const n = Array.isArray(S.repos) ? S.repos.length : null;
      $("#gh-status").textContent = `Подключено: ${m.accountLogin || "аккаунт GitHub"}` +
        (n === null ? "." : `, доступ к ${n} ${plural(n, "репозиторию", "репозиториям", "репозиториям")}.`);
      $("#gh-hint").textContent = m.appSource === "env" ? "Приложение задано переменными GITHUB_APP_* в .env." : "";
      $("#gh-manage").href = `https://github.com/settings/installations/${m.installationId}`;
    }
    $("#gh-hint").hidden = !$("#gh-hint").textContent;

    // Адреса возврата приложения привязаны к адресу панели на момент создания
    const moved = stage !== "none" && m.appBaseUrl && m.publicUrl && m.appBaseUrl !== m.publicUrl;
    show("#gh-url-warning", moved);
    if (moved) {
      $("#gh-url-warning-text").textContent = `Приложение создано для адреса ${m.appBaseUrl}, а панель сейчас работает на ${m.publicUrl}. ` +
        "GitHub будет возвращать вас на старый адрес. Нажмите «Создать приложение заново», а старое удалите на github.com/settings/apps.";
    }
  }

  function secretField(name, isSet, corrupted) {
    const input = $("#" + name);
    const btn = $(`[data-unmask="${name}"]`);
    const masked = isSet && !corrupted && !S.unmasked.has(name);
    input.disabled = masked;
    input.value = "";
    input.placeholder = masked ? "Сохранён" : corrupted ? "Не расшифровывается: введите заново" : input.dataset.placeholder || input.placeholder;
    if (!input.dataset.placeholder && !masked) input.dataset.placeholder = input.placeholder;
    btn.hidden = !masked;
  }

  function updateModelHints() {
    const provider = $("#ai_provider").value;
    const m = MODELS[provider] || MODELS.anthropic;
    $("#ai-models").replaceChildren(...m.list.map((v) => h("option", { value: v })));
    $("#ai-model-hint").textContent = m.hint;
  }

  async function ensureRepos() {
    if (S.repos || !S.loaded || !S.meta.hasGithub) {
      fillRepoSelect();
      return;
    }
    try {
      S.repos = await api("/api/repos");
      S.reposError = "";
    } catch (err) {
      S.reposError = err.message;
    }
    fillRepoSelect();
    renderGithubConnect();
  }

  function fillRepoSelect() {
    const select = $("#repo");
    if (S.dirty.has("github") && select.options.length) return;
    const current = S.settings.repo || "";
    const repos = S.repos || [];
    const options = [h("option", { value: "" }, repos.length ? "Выберите репозиторий" : "—")];
    for (const r of repos) options.push(h("option", { value: r.name, dataset: { branch: r.branch } }, r.name));
    // Текущий репозиторий остаётся в списке, даже если список не загрузился
    if (current && !repos.some((r) => r.name === current)) options.push(h("option", { value: current }, current));
    select.replaceChildren(...options);
    select.value = current;
    $("#repo-hint").textContent = S.reposError
      ? `Список не загрузился: ${S.reposError}`
      : !S.meta.hasGithub ? "Список появится после подключения GitHub." : repos.length ? `Доступно репозиториев: ${repos.length}.` : "Загружаю список…";
  }

  async function saveSection(form) {
    const section = form.dataset.section;
    const btn = form.querySelector('button[type="submit"]');
    if (section === "security") return changePassword(btn);

    const v = (id) => $("#" + id).value.trim();
    const payload = {};
    if (section === "github") {
      payload.branch = v("branch");
      // Пустой репозиторий отправляем, только если список загрузился и выбор сделан осознанно
      if (v("repo") || S.repos) payload.repo = v("repo");
    }
    if (section === "telegram") {
      payload.channel_id = v("channel_id");
      payload.tg_notify_drafts = $("#tg_notify_drafts").checked ? "1" : "0";
    }
    if (section === "ai") {
      payload.ai_provider = v("ai_provider");
      payload.ai_model = v("ai_model");
    }
    if (section === "behavior") {
      for (const k of ["mode", "digest_time", "digest_tz", "poll_interval", "debounce", "tone"]) payload[k] = v(k);
      if (payload.mode === "auto" && S.settings.mode !== "auto") {
        const ok = await confirmDialog({
          title: "Публиковать без проверки?",
          text: "Посты будут уходить в канал сразу, без вашего одобрения. Это можно выключить здесь же.",
          ok: "Включить",
        });
        if (!ok) return undefined;
      }
    }
    for (const name of ["github_token", "tg_token", "ai_key"]) {
      const input = $("#" + name);
      if (form.contains(input) && !input.disabled && input.value.trim()) payload[name] = input.value.trim();
    }

    return busy(btn, async () => {
      try {
        await api("/api/settings", { method: "POST", body: payload });
        S.dirty.delete(section);
        for (const name of ["github_token", "tg_token", "ai_key"]) if (form.contains($("#" + name))) S.unmasked.delete(name);
        if (section === "github") S.repos = null;
        toast("Сохранено.");
        await loadState();
        if (section === "github") ensureRepos();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function changePassword(btn) {
    const cur = $("#current_password").value;
    const next = $("#new_password").value;
    const again = $("#confirm_password").value;
    if (!cur || !next) return toast("Заполните текущий и новый пароль.", "error");
    if (next.length < 6) return toast("Новый пароль должен быть не короче 6 символов.", "error");
    if (next !== again) return toast("Новые пароли не совпадают.", "error");
    return busy(btn, async () => {
      try {
        await api("/api/password", { method: "POST", body: { current_password: cur, new_password: next, confirm_password: again } });
        for (const id of ["current_password", "new_password", "confirm_password"]) $("#" + id).value = "";
        S.dirty.delete("security");
        toast("Пароль изменён. Остальные сессии завершены.");
      } catch (err) {
        fail(err);
      }
    });
  }

  function initSettings() {
    for (const form of $$(".settings-section")) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        saveSection(form);
      });
      form.addEventListener("input", () => S.dirty.add(form.dataset.section));
    }

    for (const btn of $$("[data-unmask]")) {
      btn.addEventListener("click", () => {
        const name = btn.dataset.unmask;
        S.unmasked.add(name);
        const input = $("#" + name);
        input.disabled = false;
        input.placeholder = input.dataset.placeholder || "";
        btn.hidden = true;
        input.focus();
      });
    }

    for (const btn of $$("[data-test]")) {
      btn.addEventListener("click", () => testConnection(btn.dataset.test, $(`[data-result="${btn.dataset.test}"]`), btn));
    }

    $("#repo").addEventListener("change", (e) => {
      const branch = e.target.selectedOptions[0]?.dataset.branch;
      if (branch) $("#branch").value = branch;
    });
    $("#ai_provider").addEventListener("change", updateModelHints);
    $("#mode").addEventListener("change", (e) => {
      $("#digest-fields").hidden = e.target.value !== "digest";
    });
    for (const btn of $$("[data-preset]")) {
      btn.addEventListener("click", () => {
        $("#tone").value = btn.dataset.preset;
        S.dirty.add("behavior");
      });
    }

    $("#btn-owner-code").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const box = $("#owner-code");
      try {
        const res = await api("/api/telegram/owner-code", { method: "POST" });
        box.className = "result is-ok";
        box.replaceChildren("Отправьте боту в личку: ", h("code", { class: "mono" }, res.command), ". Код действует 15 минут.",
          res.link ? h("span", {}, " ", h("a", { href: res.link, target: "_blank", rel: "noopener noreferrer" }, "Открыть бота")) : null);
      } catch (err) {
        box.className = "result is-error";
        box.textContent = err.message;
      }
      box.hidden = false;
    }));

    $("#btn-owner-reset").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const ok = await confirmDialog({
        title: "Отвязать владельца?",
        text: "Бот перестанет присылать вам черновики и отвечать на команды, пока вы не привяжетесь заново по коду.",
        ok: "Отвязать",
      });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          await api("/api/test/reset-owner", { method: "POST" });
          toast("Владелец отвязан.");
          await loadState();
        } catch (err) {
          fail(err);
        }
      });
    });

    $("#btn-test-post").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const ok = await confirmDialog({
        title: "Отправить тест в канал?",
        text: "В канале появится тестовое сообщение, его увидят подписчики. Потом его можно удалить вручную.",
        ok: "Отправить",
        danger: false,
      });
      if (!ok) return;
      await testConnection("channel-post", $('[data-result="telegram"]'), btn);
    });

    $("#gh-connect-btn").addEventListener("click", async (e) => {
      if (S.meta.encryption) return;
      e.preventDefault();
      const ok = await confirmDialog({
        title: "Ключ будет храниться без шифрования",
        text: "ENCRYPTION_KEY не задан, поэтому закрытый ключ приложения GitHub ляжет в базу открытым текстом. Лучше задать ключ в .env и перезапустить сервер.",
        ok: "Всё равно подключить",
      });
      if (ok) location.href = "/auth/github/create";
    });

    $("#gh-recreate").addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Создать приложение GitHub заново?",
        text: "Нужно, если панель переехала на другой адрес. После создания нового приложения текущее подключение заменится. Старое приложение удалите вручную на github.com/settings/apps.",
        ok: "Создать заново",
        danger: false,
      });
      if (ok) location.href = "/auth/github/create?recreate=1";
    });

    $("#gh-disconnect").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const ok = await confirmDialog({
        title: "Отключить GitHub?",
        text: "Панель забудет установку и ключ приложения и перестанет видеть коммиты. Само приложение останется на GitHub, удалить его можно на github.com/settings/apps.",
        ok: "Отключить",
      });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          const res = await api("/api/github/disconnect", { method: "POST" });
          S.repos = null;
          toast(res.message || "GitHub отключён.");
          await loadState();
        } catch (err) {
          fail(err);
        }
      });
    });
  }

  // ===== Клавиатура =====
  function onKeydown(e) {
    if ($("#confirm").open) return; // Esc и Tab внутри диалога обрабатывает браузер
    if (e.key === "Escape") {
      if (!$("#conn-popover").hidden) {
        const kind = $("#conn-popover").dataset.kind;
        closePopover();
        $(`.conn-btn[data-conn="${kind}"]`)?.focus();
        return;
      }
      if (S.view === "posts" && isNarrow() && S.selectedId) selectPost(null);
      return;
    }
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || S.view !== "posts" || S.loginVisible) return;
    if (e.key === "j" || e.key === "k") {
      const posts = allPosts();
      if (!posts.length) return;
      const idx = posts.findIndex((p) => p.id === S.selectedId);
      const next = e.key === "j" ? Math.min(posts.length - 1, idx + 1) : Math.max(0, idx === -1 ? 0 : idx - 1);
      e.preventDefault();
      selectPost(posts[next].id, { replace: !isNarrow() });
      $(`.post-item[data-id="${posts[next].id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  // После переходов на GitHub сервер возвращает в панель с ?toast=… или ?error=…
  function showReturnMessage() {
    const params = new URLSearchParams(location.search);
    const toasts = { github_connected: "GitHub подключён.", github_updated: "Доступ к репозиториям обновлён." };
    if (params.get("toast")) toast(toasts[params.get("toast")] || "Готово.");
    if (params.get("error")) toast(params.get("error"), "error");
    if (params.has("toast") || params.has("error")) history.replaceState(null, "", location.pathname + location.hash);
  }

  // ===== Запуск =====
  function init() {
    $("#login-form").addEventListener("submit", onLogin);
    $("#btn-logout").addEventListener("click", onLogout);
    $("#btn-logout-2").addEventListener("click", onLogout);
    $("#btn-check").addEventListener("click", (e) => runCheck(e.currentTarget));
    $("#btn-more").addEventListener("click", (e) => loadMore(e.currentTarget));
    for (const btn of $$(".filter")) btn.addEventListener("click", () => setFilter(btn.dataset.filter));

    for (const btn of $$(".conn-btn")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openPopover(btn.dataset.conn, btn);
      });
    }
    $("#pop-test").addEventListener("click", (e) => testConnection($("#conn-popover").dataset.kind, $("#pop-result"), e.currentTarget));
    $("#pop-settings").addEventListener("click", () => {
      const kind = $("#conn-popover").dataset.kind;
      closePopover();
      location.hash = `#settings/${kind}`;
    });
    document.addEventListener("click", (e) => {
      if (!$("#conn-popover").hidden && !e.target.closest("#conn-popover")) closePopover();
    });
    window.addEventListener("resize", closePopover);

    document.addEventListener("keydown", onKeydown);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !S.loginVisible) loadState();
    });
    window.addEventListener("hashchange", applyRoute);

    initSettings();
    showReturnMessage();
    if (!location.hash) history.replaceState(null, "", "#posts");
    applyRoute();
    loadState().then(() => {
      if (S.view === "settings") ensureRepos();
      flushSaves();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
