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
        telegram: data.telegram || {},
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
    const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
    const [view, arg] = path.split("/");
    S.view = ["settings", "commits"].includes(view) ? view : "posts";
    if (S.view === "posts") {
      const id = Number(arg);
      S.selectedId = Number.isInteger(id) && id > 0 ? id : null;
    }
    closePopover();
    render();
    if (S.view === "settings") {
      ensureRepos();
      ensureModels();
      loadMemory();
      if (arg) $(`#sec-${arg}`)?.scrollIntoView({ block: "start" });
      else window.scrollTo(0, 0);
    }
    if (S.view === "commits") openCommits(new URLSearchParams(query));
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
    $("#view-commits").hidden = S.view !== "commits";
    for (const a of $$(".view-link")) {
      if (a.dataset.view === S.view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const drafts = S.counts.draft || 0;
    $("#nav-drafts").textContent = drafts ? String(drafts) : "";
    document.title = drafts ? `(${drafts}) Анонсы из коммитов` : "Анонсы из коммитов";

    renderConn();
    for (const b of $$("[data-tg-banner]")) b.hidden = !S.loaded || !!S.meta.telegram?.configured;
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
      const t = S.meta.telegram || {};
      const bot = t.username ? "@" + t.username : "Бот";
      if (!t.configured) return { state: "is-error", title: "Бот не настроен", text: "Задайте TG_BOT_TOKEN в .env и перезапустите сервер." };
      if (t.error) return { state: "is-error", title: "Telegram не принимает токен", text: t.error };
      if (t.source === "legacy") return { state: "is-warn", title: `${bot}: старый токен из базы`, text: "Добавьте TG_BOT_TOKEN в .env и удалите старое значение в настройках." };
      if (!s.channel_id) return { state: "is-warn", title: `${bot}: канал не выбран`, text: `Добавьте ${bot} администратором канала с правом публикации или впишите @канал в настройках.` };
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

  async function testConnection(kind, resultEl, btn, body) {
    let ok = false;
    await busy(btn, async () => {
      resultEl.hidden = false;
      resultEl.className = resultEl.className.replace(/ ?is-(ok|error)/g, "");
      resultEl.textContent = "Проверяю…";
      try {
        const res = await api(`/api/test/${kind}`, { method: "POST", body: body || {} });
        resultEl.textContent = res.message || "Подключение работает.";
        resultEl.classList.add("is-ok");
        ok = true;
      } catch (err) {
        resultEl.textContent = err.message;
        resultEl.classList.add("is-error");
      }
    });
    return ok;
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
      { done: !!S.meta.telegram?.configured && !!s.channel_id, text: "Бот и канал в Telegram", section: "telegram" },
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

    renderTelegramBot();
    fill("telegram", () => {
      $("#channel_id").value = s.channel_id || "";
      $("#tg_notify_drafts").checked = s.tg_notify_drafts === "1";
    });
    $("#owner-status").textContent = s.tg_owner_chat_id
      ? `Привязан: ${s.tg_owner_username || "владелец"} (ID ${s.tg_owner_chat_id})`
      : "Не привязан.";
    $("#btn-owner-code").textContent = s.tg_owner_chat_id ? "Сменить" : "Привязать Telegram";
    $("#btn-owner-code").disabled = !S.meta.telegram?.configured;
    $("#btn-owner-reset").hidden = !s.tg_owner_chat_id;

    fill("ai", () => {
      $("#ai_provider").value = s.ai_provider || "anthropic";
      secretField("ai_key", s.ai_key_set, s.ai_key_corrupted);
      $("#ai_model").value = s.ai_model || "";
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

  // Раздел Telegram: бот из TG_BOT_TOKEN, его имя (getMe) и старый токен из базы
  function renderTelegramBot() {
    const t = S.meta.telegram || {};
    const bot = t.username ? "@" + t.username : "";
    let status;
    let hint = "";
    if (!t.configured) {
      status = "Бот не настроен: задайте TG_BOT_TOKEN в .env и перезапустите сервер.";
      hint = "Токен выдаёт @BotFather командой /newbot.";
    } else if (t.error) {
      status = t.error;
      hint = "Проверьте TG_BOT_TOKEN в .env и перезапустите сервер.";
    } else if (bot) {
      status = `Бот ${bot} подключён.`;
      hint = `Добавьте ${bot} администратором канала с правом публикации.`;
    } else {
      status = "Токен задан. Нажмите «Проверить», чтобы узнать имя бота.";
    }
    $("#tg-bot-status").textContent = status;
    $("#tg-bot-hint").textContent = hint;
    $("#tg-bot-hint").hidden = !hint;
    $("#tg-legacy").hidden = !t.legacy_token;
    $("#tg-legacy-text").textContent = t.source === "legacy"
      ? "Пока TG_BOT_TOKEN не задан, бот работает со старым токеном из базы."
      : "TG_BOT_TOKEN задан, старое значение из базы не используется.";
    $("#btn-test-post").disabled = !t.configured;
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

  // ===== Подсказки моделей ИИ: список у провайдера по ключу пользователя =====
  // Список только подсказывает: модель попадает в поле, лишь когда человек её выбрал.
  const PROVIDER_NAMES = { anthropic: "Anthropic", openai: "OpenAI" };
  // query: текст, набранный после открытия списка; null — список открыт без поиска (показываем всё)
  const M = { provider: "", models: null, fallback: false, error: "", loading: false, active: -1, req: 0, info: "", query: null };

  // Ключ, который введён в форму, но ещё не сохранён (используется только для запроса списка)
  const typedAiKey = () => {
    const input = $("#ai_key");
    return !input.disabled && input.value.trim() ? input.value.trim() : "";
  };

  function modelHint() {
    const provider = $("#ai_provider").value;
    if (M.loading) return "Загружаю список моделей…";
    if (M.models && !M.fallback) return M.info;
    if (!S.settings.ai_key_set && !typedAiKey()) {
      return provider === "openai"
        ? "Название из вашего кабинета OpenAI. Список появится после ввода ключа."
        : "Список моделей появится после ввода ключа.";
    }
    return provider === "openai" ? "Название из вашего кабинета OpenAI." : "";
  }

  function renderModels() {
    $("#model-combo").classList.toggle("is-loading", M.loading);
    $("#ai_model").readOnly = M.loading;
    $("#ai_model").setAttribute("aria-busy", String(M.loading));
    $("#ai-model-hint").textContent = modelHint();
    $("#models-error").hidden = !M.error;
    $("#models-error-text").textContent = M.error;
    if (!$("#model-list").hidden) renderModelList();
  }

  function modelOptions() {
    const list = M.models || [];
    const q = (M.query || "").trim().toLowerCase();
    const matches = (id, name = "") => !q || id.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    // Сохранённую модель показываем, даже если провайдер её не вернул, — но только для её провайдера
    const saved = (S.settings.ai_provider || "anthropic") === $("#ai_provider").value ? S.settings.ai_model || "" : "";
    const options = list.filter((m) => matches(m.id, m.name));
    if (saved && M.models && !M.fallback && !list.some((m) => m.id === saved) && matches(saved)) {
      options.unshift({ id: saved, name: "", missing: true });
    }
    return options;
  }

  function renderModelList() {
    const listEl = $("#model-list");
    const options = modelOptions();
    if (M.active >= options.length) M.active = options.length - 1;
    const items = [];
    if (M.fallback && options.length) items.push(h("li", { class: "combo-note", role: "presentation" }, "Запасной список: может быть неактуальным."));
    options.forEach((m, i) => {
      const tags = [];
      if (m.missing) tags.push(h("span", { class: "tag is-warn" }, "нет в списке провайдера"));
      if (m.deprecated) tags.push(h("span", { class: "tag is-warn", title: "Провайдер пометил модель как устаревающую" }, "устаревает"));
      if (m.cheaper) tags.push(h("span", { class: "tag", title: "Определено по названию, цены смотрите у провайдера" }, "обычно дешевле"));
      items.push(h("li", {
        class: "combo-option" + (i === M.active ? " is-active" : ""),
        role: "option",
        id: `model-opt-${i}`,
        "aria-selected": String(i === M.active),
        dataset: { id: m.id },
        // mousedown, а не click: иначе поле потеряет фокус раньше выбора
        onmousedown: (e) => {
          e.preventDefault();
          chooseModel(m.id);
        },
      }, h("span", { class: "mono" }, m.id), m.name && m.name !== m.id ? h("span", { class: "combo-name" }, m.name) : null, ...tags));
    });
    if (!options.length) {
      items.push(h("li", { class: "combo-empty", role: "presentation" },
        M.models ? "Нет совпадений: можно вписать название вручную." : "Список не загружен: впишите название вручную."));
    }
    listEl.replaceChildren(...items);
    const input = $("#ai_model");
    if (M.active >= 0) input.setAttribute("aria-activedescendant", `model-opt-${M.active}`);
    else input.removeAttribute("aria-activedescendant");
    $(`#model-opt-${M.active}`)?.scrollIntoView({ block: "nearest" });
    return options;
  }

  function openModelList() {
    if ($("#model-list").hidden) M.query = null;
    $("#model-list").hidden = false;
    $("#ai_model").setAttribute("aria-expanded", "true");
    renderModelList();
  }

  function closeModelList() {
    $("#model-list").hidden = true;
    M.active = -1;
    M.query = null;
    const input = $("#ai_model");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function chooseModel(id) {
    $("#ai_model").value = id;
    S.dirty.add("ai");
    closeModelList();
  }

  function onModelKeydown(e) {
    const open = !$("#model-list").hidden;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openModelList();
      const count = modelOptions().length;
      if (!count) return;
      M.active = e.key === "ArrowDown" ? (M.active + 1) % count : M.active <= 0 ? count - 1 : M.active - 1;
      renderModelList();
    } else if (e.key === "Enter" && open && M.active >= 0) {
      e.preventDefault();
      chooseModel(modelOptions()[M.active].id);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      closeModelList();
    }
  }

  async function loadModels({ refresh = false } = {}) {
    const provider = $("#ai_provider").value;
    const key = typedAiKey();
    if (!key && !S.settings.ai_key_set) {
      Object.assign(M, { provider, models: null, fallback: false, error: "", loading: false });
      renderModels();
      return;
    }
    const req = ++M.req;
    Object.assign(M, { provider, loading: true, error: "" });
    renderModels();
    try {
      const res = key
        ? await api("/api/ai/models", { method: "POST", body: { provider, key, refresh } })
        : await api(`/api/ai/models?provider=${provider}${refresh ? "&refresh=1" : ""}`);
      if (req !== M.req) return;
      const when = new Date(res.fetched_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      Object.assign(M, {
        models: res.models,
        fallback: false,
        info: `Моделей у ${PROVIDER_NAMES[provider]}: ${res.models.length} (список на ${when}). Начните вводить название или выберите из списка.`,
      });
    } catch (err) {
      if (req !== M.req) return;
      const fallback = err.data?.fallback || [];
      Object.assign(M, { models: fallback.length ? fallback : null, fallback: true, error: err.message });
    } finally {
      if (req === M.req) {
        M.loading = false;
        renderModels();
      }
    }
  }

  // При открытии настроек список подгружается один раз, если ключ уже сохранён
  function ensureModels() {
    if (!S.loaded || !S.settings.ai_key_set || M.loading) return;
    if (M.provider === $("#ai_provider").value && (M.models || M.error)) return;
    loadModels();
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
    if (section === "memory") return undefined;

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
    for (const name of ["github_token", "ai_key"]) {
      const input = $("#" + name);
      if (form.contains(input) && !input.disabled && input.value.trim()) payload[name] = input.value.trim();
    }

    return busy(btn, async () => {
      try {
        await api("/api/settings", { method: "POST", body: payload });
        S.dirty.delete(section);
        for (const name of ["github_token", "ai_key"]) if (form.contains($("#" + name))) S.unmasked.delete(name);
        if (section === "github") S.repos = null;
        toast("Сохранено.");
        await loadState();
        if (section === "github") ensureRepos();
        if (section === "ai") loadModels();
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
      btn.addEventListener("click", async () => {
        const kind = btn.dataset.test;
        const body = kind === "ai"
          ? { provider: $("#ai_provider").value, model: $("#ai_model").value.trim(), key: typedAiKey() || undefined }
          : undefined;
        const ok = await testConnection(kind, $(`[data-result="${kind}"]`), btn, body);
        if (kind === "telegram") loadState(); // имя бота из свежего getMe
        if (kind === "ai" && ok) loadModels();
      });
    }

    $("#repo").addEventListener("change", (e) => {
      const branch = e.target.selectedOptions[0]?.dataset.branch;
      if (branch) $("#branch").value = branch;
    });
    $("#ai_provider").addEventListener("change", () => {
      Object.assign(M, { models: null, error: "" });
      closeModelList();
      loadModels();
    });
    const modelInput = $("#ai_model");
    modelInput.addEventListener("input", () => {
      openModelList();
      M.active = -1;
      M.query = modelInput.value;
      renderModelList();
    });
    modelInput.addEventListener("focus", () => {
      if (M.models) openModelList();
    });
    // Клик по полю, которое уже в фокусе, тоже открывает список
    modelInput.addEventListener("click", () => {
      if ($("#model-list").hidden) openModelList();
    });
    modelInput.addEventListener("blur", closeModelList);
    modelInput.addEventListener("keydown", onModelKeydown);
    $("#btn-models-refresh").addEventListener("click", () => loadModels({ refresh: true }));
    $("#btn-models-retry").addEventListener("click", () => loadModels({ refresh: true }));
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
        box.className = "result";
        box.replaceChildren(
          h("p", {}, h("a", { class: "btn btn-primary btn-sm", href: res.link, target: "_blank", rel: "noopener noreferrer" }, `Открыть @${res.username} в Telegram`)),
          h("p", { class: "hint" }, "В боте нажмите «Запустить» (Start). Или отправьте ему: ", h("code", { class: "mono" }, res.command),
            `. Код одноразовый и действует ${res.ttl_minutes} минут.`)
        );
      } catch (err) {
        box.className = "result is-error";
        box.textContent = err.message;
      }
      box.hidden = false;
    }));

    $("#btn-tg-legacy-delete").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const usingLegacy = S.meta.telegram?.source === "legacy";
      const ok = await confirmDialog({
        title: "Удалить старый токен бота из базы?",
        text: usingLegacy
          ? "Сейчас бот работает именно с ним: после удаления бот выключится, пока вы не зададите TG_BOT_TOKEN в .env и не перезапустите сервер."
          : "Бот работает с TG_BOT_TOKEN из .env, старое значение больше не нужно.",
        ok: "Удалить",
      });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          const res = await api("/api/telegram/legacy-token/delete", { method: "POST" });
          toast(res.message);
          await loadState();
        } catch (err) {
          fail(err);
        }
      });
    });

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

  // ===== Память канала: журнал объявленного =====
  async function loadMemory() {
    try {
      const res = await api("/api/memory");
      $("#memory-status").textContent = res.total
        ? `В памяти ${res.total} ${plural(res.total, "пункт", "пункта", "пунктов")} за последние ${res.days} дней.`
        : `За последние ${res.days} дней в памяти пусто.`;
      $("#memory-list").replaceChildren(...res.items.map((it) => h("li", {},
        h("span", { class: "memory-name" }, it.name), it.summary ? h("span", { class: "memory-summary" }, " — " + it.summary) : null,
        h("span", { class: "memory-src" }, it.post_id ? ` · пост #${it.post_id}` : " · добавлено вручную"))));
    } catch (err) {
      if (err.status !== 401) $("#memory-status").textContent = "Не удалось загрузить память: " + err.message;
    }
  }

  function memoryRow(item = { name: "", summary: "" }) {
    const remove = h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-label": "Убрать пункт" }, "Убрать");
    const row = h("li", { class: "memory-row" },
      h("input", { class: "input memory-row-name", maxlength: "100", placeholder: "Название", "aria-label": "Название", value: item.name }),
      h("input", { class: "input memory-row-summary", maxlength: "300", placeholder: "Что объявлено", "aria-label": "Что объявлено", value: item.summary || "" }),
      remove);
    remove.addEventListener("click", () => row.remove());
    return row;
  }

  function initMemory() {
    const result = $("#memory-result");
    const show = (text, kind) => {
      result.textContent = text;
      result.className = "result" + (kind ? " is-" + kind : "");
      result.hidden = !text;
    };
    $("#btn-memory-extract").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const text = $("#memory-text").value.trim();
      if (!text) return show("Вставьте текст старого поста.", "error");
      show("ИИ выписывает названия…");
      try {
        const res = await api("/api/memory/extract", { method: "POST", body: { text } });
        $("#memory-edit").replaceChildren(...(res.items.length ? res.items : [{ name: "", summary: "" }]).map(memoryRow));
        $("#memory-draft").hidden = false;
        show(res.items.length ? "Проверьте и поправьте пункты, затем сохраните." : "ИИ не нашёл объявленных функций. Можно вписать пункты вручную.");
      } catch (err) {
        if (err.status !== 401) show(err.message, "error");
      }
    }));
    $("#btn-memory-add-row").addEventListener("click", () => $("#memory-edit").append(memoryRow()));
    $("#btn-memory-cancel").addEventListener("click", () => {
      $("#memory-draft").hidden = true;
      show("");
    });
    $("#btn-memory-save").addEventListener("click", (e) => busy(e.currentTarget, async () => {
      const items = $$(".memory-row", $("#memory-edit"))
        .map((row) => ({ name: $(".memory-row-name", row).value.trim(), summary: $(".memory-row-summary", row).value.trim() }))
        .filter((it) => it.name);
      if (!items.length) return show("Нет пунктов с названием.", "error");
      try {
        const res = await api("/api/memory/items", { method: "POST", body: { items } });
        $("#memory-draft").hidden = true;
        $("#memory-text").value = "";
        show(`Сохранено в память: ${res.added}.`, "ok");
        loadMemory();
      } catch (err) {
        if (err.status !== 401) show(err.message, "error");
      }
    }));
  }

  // ===== Вкладка «Коммиты» =====
  const MAX_SELECTED = 20;
  const C = {
    filters: { branch: "", author: "", since: "", until: "", q: "" },
    loadedKey: null, // фильтры, для которых загружен список
    items: [],
    page: 0,
    hasMore: false,
    loading: false,
    error: null, // { message, code }
    selected: new Set(),
    anchor: null,
    cursor: 0,
    expanded: new Map(), // sha → { loading } | { error } | { message, files }
    branches: null,
    req: 0,
  };
  const serverFilters = (f) => JSON.stringify([f.branch, f.author, f.since, f.until]);

  // Фильтры живут в адресе: #commits?branch=…&author=…&since=…&until=…&q=…
  function writeCommitsHash() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(C.filters)) if (v) params.set(k, v);
    const hash = "#commits" + (params.toString() ? "?" + params : "");
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function openCommits(params) {
    const branch = params.get("branch") || S.settings.branch || "";
    C.filters = { branch, author: params.get("author") || "", since: params.get("since") || "", until: params.get("until") || "", q: params.get("q") || "" };
    $("#c-author").value = C.filters.author;
    $("#c-since").value = C.filters.since;
    $("#c-until").value = C.filters.until;
    $("#c-q").value = C.filters.q;
    if (!S.loaded) return; // список загрузится после состояния панели
    loadBranches();
    if (C.loadedKey !== serverFilters(C.filters) && !C.loading) loadCommits({ reset: true });
    else renderCommits();
  }

  async function loadBranches(refresh = false) {
    if (C.branches && !refresh) return fillBranches();
    try {
      const res = await api("/api/branches" + (refresh ? "?refresh=1" : ""));
      C.branches = res.branches.map((b) => b.name);
    } catch {
      C.branches = null; // без списка веток остаётся текущая
    }
    fillBranches();
  }

  function fillBranches() {
    const select = $("#c-branch");
    const names = new Set(C.branches || []);
    if (C.filters.branch) names.add(C.filters.branch);
    select.replaceChildren(...[...names].map((n) => h("option", { value: n }, n + (n === S.settings.branch ? " (основная)" : ""))));
    select.value = C.filters.branch;
    const other = C.filters.branch && S.settings.branch && C.filters.branch !== S.settings.branch;
    $("#c-branch-note").hidden = !other;
    if (other) $("#c-branch-note-text").textContent = `Вы смотрите ветку «${C.filters.branch}». Автоматическая проверка следит за «${S.settings.branch}».`;
  }

  async function loadCommits({ reset = false, refresh = false } = {}) {
    const f = C.filters;
    const key = serverFilters(f);
    if (reset) {
      Object.assign(C, { items: [], page: 0, hasMore: false, error: null, cursor: 0, anchor: null });
      C.expanded.clear();
    }
    const page = C.page + 1;
    const req = ++C.req;
    C.loading = true;
    renderCommits();
    const params = new URLSearchParams({ page });
    for (const k of ["branch", "author", "since", "until"]) if (f[k]) params.set(k, f[k]);
    if (refresh) params.set("refresh", "1");
    try {
      const res = await api("/api/commits?" + params);
      if (req !== C.req) return false;
      const known = new Set(C.items.map((c) => c.sha));
      C.items.push(...res.commits.filter((c) => !known.has(c.sha)));
      Object.assign(C, { page, hasMore: res.has_more, loadedKey: key, error: null });
      return true;
    } catch (err) {
      if (req !== C.req) return false;
      C.error = { message: err.message, code: err.data?.code };
      C.loadedKey = key;
      return false;
    } finally {
      if (req === C.req) {
        C.loading = false;
        renderCommits();
      }
    }
  }

  // «Искать глубже»: догружаем страницы, пока есть, но не дальше 300 коммитов
  async function searchDeeper(btn) {
    await busy(btn, async () => {
      while (C.hasMore && C.items.length < 300) {
        if (!(await loadCommits())) break;
      }
    });
  }

  const visibleCommits = () => {
    const q = C.filters.q.trim().toLowerCase();
    return q ? C.items.filter((c) => c.message.toLowerCase().includes(q) || c.sha.startsWith(q)) : C.items;
  };

  function renderCommits() {
    const list = $("#c-list");
    const empty = $("#c-empty");
    const items = visibleCommits();
    const filtersActive = !!(C.filters.author || C.filters.since || C.filters.until || C.filters.q);

    // Строка состояния
    const status = [];
    if (C.items.length) status.push(h("span", {}, `Загружено ${C.items.length} ${plural(C.items.length, "коммит", "коммита", "коммитов")}`));
    if (C.filters.q && C.items.length) {
      status.push(h("span", {}, `совпадений среди загруженных: ${items.length}`));
      if (C.hasMore && C.items.length < 300) {
        status.push(h("button", { type: "button", class: "link-btn", onclick: (e) => searchDeeper(e.currentTarget) }, "Искать глубже"));
      } else if (C.items.length >= 300) {
        status.push(h("span", {}, "дальше 300 коммитов поиск не идёт"));
      }
    }
    $("#c-status").replaceChildren(...status.flatMap((p, i) => (i ? [h("span", { "aria-hidden": "true" }, "·"), p] : [p])));

    // Скелетон при первой загрузке
    if (C.loading && !C.items.length) {
      list.replaceChildren(...Array.from({ length: 8 }, () => h("li", { class: "skeleton-row", "aria-hidden": "true" },
        h("span", { class: "skeleton skeleton-text" }), h("span", { class: "skeleton skeleton-text" }))));
      empty.hidden = true;
      $("#c-more-box").hidden = true;
      renderCommitBar();
      return;
    }

    // Ветку, которую не удалось загрузить, не предлагаем сделать основной
    if (C.error && !C.items.length) $("#c-branch-note").hidden = true;
    list.replaceChildren(...items.map((c, i) => commitRow(c, i)));
    $("#c-more-box").hidden = !C.hasMore || !!C.error;
    $("#c-more").textContent = C.loading ? "Загружаю…" : "Показать ещё";

    empty.hidden = items.length > 0;
    if (!items.length) {
      empty.replaceChildren(...commitsEmptyState(filtersActive));
    } else if (C.error) {
      // Ошибка при догрузке: список остаётся, причина под ним
      empty.hidden = false;
      empty.replaceChildren(h("p", { class: "result is-error" }, C.error.message), h("button", { type: "button", class: "btn btn-secondary", onclick: () => loadCommits() }, "Повторить"));
    }
    renderCommitBar();
  }

  function commitsEmptyState(filtersActive) {
    if (C.loading) return [];
    const e = C.error;
    if (e?.code === "no_repo") {
      return [h("p", { class: "empty-title" }, "Репозиторий не выбран"), h("p", { class: "empty-text" }, "Выберите репозиторий, и здесь появятся его коммиты."),
        h("a", { class: "btn btn-primary", href: "#settings/github" }, "Открыть настройки")];
    }
    if (e?.code === "no_github") {
      return [h("p", { class: "empty-title" }, "GitHub не подключён"), h("p", { class: "empty-text" }, "Подключите GitHub, чтобы видеть коммиты репозитория."),
        h("a", { class: "btn btn-primary", href: "/auth/github/create" }, "Подключить GitHub")];
    }
    if (e) {
      return [h("p", { class: "empty-title" }, "Не удалось загрузить коммиты"), h("p", { class: "empty-text" }, e.message),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => loadCommits({ reset: true, refresh: true }) }, "Повторить")];
    }
    if (C.filters.q && C.items.length) {
      return [h("p", { class: "empty-title" }, "Совпадений нет"),
        h("p", { class: "empty-text" }, `Среди ${C.items.length} загруженных коммитов нет «${C.filters.q}».`),
        C.hasMore && C.items.length < 300 ? h("button", { type: "button", class: "btn btn-primary", onclick: (ev) => searchDeeper(ev.currentTarget) }, "Искать глубже") : null];
    }
    return [h("p", { class: "empty-title" }, "Коммитов нет"),
      h("p", { class: "empty-text" }, filtersActive ? "По этим фильтрам ничего не нашлось." : "В этой ветке пока нет коммитов."),
      filtersActive ? h("button", { type: "button", class: "btn btn-primary", onclick: resetCommitFilters }, "Сбросить фильтры") : null];
  }

  function resetCommitFilters() {
    C.filters = { branch: C.filters.branch, author: "", since: "", until: "", q: "" };
    for (const id of ["c-author", "c-since", "c-until", "c-q"]) $("#" + id).value = "";
    writeCommitsHash();
    loadCommits({ reset: true });
  }

  function commitRow(c, i) {
    const selected = C.selected.has(c.sha);
    const exp = C.expanded.get(c.sha);
    const date = parseDate(c.date);
    const li = h("li", {
      class: "c-item",
      role: "option",
      id: `commit-${c.sha}`,
      "aria-selected": String(selected),
      tabindex: i === C.cursor ? "0" : "-1",
      dataset: { sha: c.sha, index: i },
      onclick: (e) => {
        if (e.target.closest("a, button, .c-detail")) return;
        C.cursor = i;
        if (e.shiftKey && C.anchor !== null) selectRange(C.anchor, i);
        else toggleCommit(c.sha, i);
      },
    },
    h("span", { class: "c-check", "aria-hidden": "true" }),
    h("div", { class: "c-main" },
      h("div", { class: "c-line" },
        h("button", { type: "button", class: "c-sha", title: "Скопировать полный идентификатор", onclick: () => copySha(c.sha) }, c.short),
        h("span", { class: "c-title" }, c.title),
        c.merge ? h("span", { class: "tag", title: "Коммит слияния веток" }, "merge") : null,
        ...c.posts.map((id) => h("a", { class: "c-post-link", href: `#posts/${id}` }, `в посте #${id}`))),
      h("div", { class: "c-meta" }, [c.author, date ? h("time", { datetime: date.toISOString(), title: fullDate(c.date) }, relLong(c.date)) : null]
        .filter(Boolean).flatMap((x, k) => (k ? [" · ", x] : [x])))),
    h("button", {
      type: "button",
      class: "c-expand",
      "aria-expanded": String(!!exp),
      "aria-label": exp ? "Скрыть подробности" : "Подробности: сообщение и файлы",
      onclick: () => toggleExpand(c.sha),
    }, icon("chevron")));
    if (exp) li.append(commitDetail(exp));
    return li;
  }

  function commitDetail(exp) {
    if (exp.loading) return h("div", { class: "c-detail" }, h("span", { class: "skeleton skeleton-text" }));
    if (exp.error) return h("div", { class: "c-detail" }, h("p", { class: "result is-error" }, exp.error));
    return h("div", { class: "c-detail" },
      h("pre", { class: "c-message" }, exp.message),
      exp.files.length
        ? h("ul", { class: "c-files", "aria-label": "Изменённые файлы" }, exp.files.map((f) => h("li", {},
          h("span", { class: "c-add" }, `+${f.additions}`), h("span", { class: "c-del" }, `−${f.deletions}`), h("span", { class: "c-file" }, f.filename))))
        : h("p", { class: "hint" }, "Файлов в коммите нет."));
  }

  async function toggleExpand(sha) {
    if (C.expanded.has(sha)) {
      C.expanded.delete(sha);
      return renderCommits();
    }
    C.expanded.set(sha, { loading: true });
    renderCommits();
    try {
      const res = await api(`/api/commits/${sha}`);
      C.expanded.set(sha, { message: res.message, files: res.files });
    } catch (err) {
      if (err.status !== 401) C.expanded.set(sha, { error: err.message });
    }
    if (C.expanded.has(sha)) renderCommits();
  }

  async function copySha(sha) {
    try {
      await navigator.clipboard.writeText(sha);
      toast(`Скопировано: ${sha.slice(0, 7)}`);
    } catch {
      toast(`Не удалось скопировать. Идентификатор: ${sha}`, "error");
    }
  }

  function toggleCommit(sha, index) {
    if (C.selected.has(sha)) C.selected.delete(sha);
    else if (C.selected.size >= MAX_SELECTED) return toast(`За раз можно выбрать не больше ${MAX_SELECTED} коммитов.`, "error");
    else C.selected.add(sha);
    C.anchor = index;
    renderCommits();
    focusCommitRow();
  }

  function selectRange(from, to) {
    const items = visibleCommits();
    const [a, b] = from < to ? [from, to] : [to, from];
    for (const c of items.slice(a, b + 1)) {
      if (C.selected.size >= MAX_SELECTED) {
        toast(`За раз можно выбрать не больше ${MAX_SELECTED} коммитов.`, "error");
        break;
      }
      C.selected.add(c.sha);
    }
    renderCommits();
    focusCommitRow();
  }

  function clearSelection() {
    if (!C.selected.size) return;
    C.selected.clear();
    C.anchor = null;
    renderCommits();
  }

  function focusCommitRow() {
    $(`#c-list [data-index="${C.cursor}"]`)?.focus({ preventScroll: false });
  }

  function commitsKeydown(e) {
    const items = visibleCommits();
    if (!items.length) return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      C.cursor = Math.max(0, Math.min(items.length - 1, C.cursor + (e.key === "j" ? 1 : -1)));
      renderCommits();
      focusCommitRow();
    } else if ((e.key === " " || e.key === "Enter") && e.target.closest?.(".c-item")) {
      if (e.target.closest("button, a")) return;
      e.preventDefault();
      const c = items[C.cursor];
      if (e.key === " ") toggleCommit(c.sha, C.cursor);
      else toggleExpand(c.sha).then(focusCommitRow);
    }
  }

  function renderCommitBar() {
    const n = C.selected.size;
    $("#c-bar").hidden = n === 0;
    $("#c-count").textContent = `Выбрано: ${n} из ${MAX_SELECTED}`;
    $("#c-create").textContent = `Создать пост из ${n} ${plural(n, "коммита", "коммитов", "коммитов")}`;
  }

  async function createFromCommits(btn) {
    const shas = [...C.selected];
    const send = (confirm) => api("/api/posts/from-commits", { method: "POST", body: { shas, branch: C.filters.branch, confirm_duplicates: confirm } });
    await busy(btn, async () => {
      let res;
      try {
        res = await send(false);
      } catch (err) {
        if (err.status !== 409) return fail(err);
        const list = (err.data?.duplicates || []).map((d) => `${d.short} (${d.posts.map((p) => "пост #" + p).join(", ")})`).join(", ");
        const ok = await confirmDialog({
          title: "Эти коммиты уже есть в постах",
          text: `${list}. Создать ещё один пост, в котором они повторятся?`,
          ok: "Создать всё равно",
        });
        if (!ok) return;
        try {
          res = await send(true);
        } catch (err2) {
          return fail(err2);
        }
      }
      C.selected.clear();
      C.anchor = null;
      C.loadedKey = null; // бейджи «в посте #N» обновятся при следующем открытии
      toast(`Черновик #${res.id} создаётся из ${res.commits} ${plural(res.commits, "коммита", "коммитов", "коммитов")}: ИИ пишет текст.`);
      await loadState();
      location.hash = `#posts/${res.id}`;
    });
  }

  function initCommits() {
    $("#c-filters").addEventListener("submit", (e) => {
      e.preventDefault();
      loadBranches(true);
      loadCommits({ reset: true, refresh: true });
    });
    const applyFilter = () => {
      const next = {
        branch: $("#c-branch").value || C.filters.branch,
        author: $("#c-author").value.trim(),
        since: $("#c-since").value,
        until: $("#c-until").value,
        q: $("#c-q").value,
      };
      const reload = serverFilters(next) !== serverFilters(C.filters);
      C.filters = next;
      writeCommitsHash();
      fillBranches();
      if (reload) loadCommits({ reset: true });
      else renderCommits();
    };
    for (const id of ["c-branch", "c-author", "c-since", "c-until"]) $("#" + id).addEventListener("change", applyFilter);
    $("#c-q").addEventListener("input", () => {
      C.filters.q = $("#c-q").value;
      C.cursor = 0;
      writeCommitsHash();
      renderCommits();
    });
    $("#c-more").addEventListener("click", (e) => busy(e.currentTarget, () => loadCommits()));
    $("#c-clear").addEventListener("click", clearSelection);
    $("#c-create").addEventListener("click", (e) => createFromCommits(e.currentTarget));
    $("#c-make-default").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const branch = C.filters.branch;
      const ok = await confirmDialog({
        title: `Сделать «${branch}» основной веткой?`,
        text: "Автоматическая проверка начнёт следить за этой веткой с её последнего коммита: уже сделанные коммиты в посты не попадут.",
        ok: "Сделать основной",
        danger: false,
      });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          await api("/api/settings", { method: "POST", body: { branch } });
          toast(`Основная ветка: ${branch}.`);
          await loadState();
          fillBranches();
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
      if (S.view === "commits" && !isTyping(e.target)) clearSelection();
      return;
    }
    if (S.view === "commits" && !S.loginVisible && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      commitsKeydown(e);
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
    initMemory();
    initCommits();
    showReturnMessage();
    if (!location.hash) history.replaceState(null, "", "#posts");
    applyRoute();
    loadState().then(() => {
      if (S.view === "settings") {
        ensureRepos();
        ensureModels();
      }
      if (S.view === "commits") openCommits(new URLSearchParams(location.hash.split("?")[1] || ""));
      flushSaves();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
