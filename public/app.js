/**
 * gh-tg-web - Single-page Application Client
 * Pure Vanilla JavaScript without external dependencies.
 */

(function () {
  "use strict";

  // Application State
  const state = {
    currentTab: "posts",
    currentSection: "github",
    currentFilter: "all",
    limit: 15,
    offset: 0,
    hasMore: false,
    posts: [],
    counts: { total: 0, draft: 0, sent: 0, skipped: 0, failed: 0 },
    settings: {},
    status: {},
    github_app_configured: false,
    github_app_slug: "",
    github_installation_id: null,
    github_account_login: "",
    has_github_token: false,
    has_tg_token: false,
    has_ai_key: false,
    encryption_enabled: false,
    domain: "",
    debounce_until: null,
    next_poll_in: null,
    activeEditingId: null,
    unmaskedSecrets: new Set(),
  };

  // Helper: DOM Element Selectors
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Helper: Toast Notifications
  function showToast(message, type = "success") {
    const container = $("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "alert");
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(16px)";
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  function showLogin(errMessage) {
    const overlay = $("login-overlay");
    const appEl = $("app");
    if (overlay) overlay.style.display = "flex";
    if (appEl) appEl.setAttribute("hidden", "hidden");
    const errEl = $("login-error");
    if (errEl) {
      if (errMessage) {
        errEl.textContent = errMessage;
        errEl.style.display = "block";
      } else {
        errEl.style.display = "none";
      }
    }
    const pw = $("pw");
    if (pw) {
      pw.value = "";
      pw.focus();
    }
  }

  function hideLogin() {
    const overlay = $("login-overlay");
    const appEl = $("app");
    if (overlay) overlay.style.display = "none";
    if (appEl) appEl.removeAttribute("hidden");
  }

  // Helper: Async API Requests
  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (options.body && !(options.body instanceof FormData) && typeof options.body === "object") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401 && path !== "/login") {
      showLogin();
      throw new Error("Требуется авторизация");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error || data.message || `Ошибка сервера (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // Helper: Button Loading State
  async function withButton(btn, asyncFn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      return await asyncFn();
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  // Relative Time Formatter
  function timeAgo(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);
    if (diffSec < 45) return "только что";
    if (diffSec < 90) return "1 минуту назад";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 45) return `${diffMin} мин. назад`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} ч. назад`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "вчера";
    if (diffDays < 7) return `${diffDays} дн. назад`;
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function fullDateTime(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ==================== Navigation Tabs ====================
  function setTab(tabName) {
    state.currentTab = tabName;
    $$(".nav-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
    });
    $("view-posts").classList.toggle("active", tabName === "posts");
    $("view-settings").classList.toggle("active", tabName === "settings");
    if (history.replaceState) {
      history.replaceState(null, "", `#${tabName}`);
    }
  }

  function setSettingsSection(sectionName) {
    state.currentSection = sectionName;
    $$(".settings-nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.section === sectionName);
    });
    $$(".settings-section").forEach((sec) => {
      sec.classList.toggle("active", sec.dataset.section === sectionName);
    });
  }

  // ==================== Fetch State & Populate ====================
  async function loadState(isInitial = false) {
    try {
      const data = await api(`/api/state?limit=${state.limit}&offset=0&filter=${state.currentFilter}`);
      hideLogin();
      state.settings = data.settings || {};
      state.status = data.status || {};
      state.github_app_configured = Boolean(data.github_app_configured);
      state.github_app_slug = data.github_app_slug || "";
      state.github_installation_id = data.github_installation_id || null;
      state.github_account_login = data.github_account_login || "";
      state.has_github_token = Boolean(data.settings?.github_token_set || data.has_github_token || state.github_installation_id);
      state.has_tg_token = Boolean(data.settings?.tg_token_set || data.has_tg_token);
      state.has_ai_key = Boolean(data.settings?.ai_key_set || data.has_ai_key);
      state.counts = data.counts || { total: 0, draft: 0, sent: 0, skipped: 0, failed: 0 };
      state.encryption_enabled = Boolean(data.encryption_enabled);
      state.domain = data.domain || "";
      state.debounce_until = data.debounce_until || null;
      state.next_poll_in = data.next_poll_in ?? 5;

      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get("toast") === "github_connected") {
        showToast("GitHub подключён!");
        urlParams.delete("toast");
        const cleanSearch = urlParams.toString() ? "?" + urlParams.toString() : "";
        history.replaceState(null, "", window.location.pathname + cleanSearch + (window.location.hash || "#settings"));
      }
      if (urlParams.get("error")) {
        showToast(decodeURIComponent(urlParams.get("error")), "error");
        urlParams.delete("error");
        const cleanSearch = urlParams.toString() ? "?" + urlParams.toString() : "";
        history.replaceState(null, "", window.location.pathname + cleanSearch + (window.location.hash || "#settings"));
      }

      const newPosts = data.posts || [];
      state.posts = newPosts;
      state.hasMore = newPosts.length < state.counts[state.currentFilter === "all" ? "total" : state.currentFilter];

      renderHeader();
      renderSummary();
      renderFilters();
      renderOnboarding();
      renderFeed();

      if (isInitial) {
        populateSettingsForms();
        // If nothing is configured at all, route to onboarding/settings
        if (!state.has_github_token && !state.has_tg_token && !state.has_ai_key) {
          const hash = window.location.hash.replace("#", "");
          if (hash === "settings") {
            setTab("settings");
          } else {
            setTab("posts");
          }
        } else {
          const hash = window.location.hash.replace("#", "");
          if (hash === "settings") setTab("settings");
          else setTab("posts");
        }
      } else {
        // Update GitHub App UI on subsequent polls
        populateGitHubAppPane();
      }
    } catch (err) {
      console.error("Ошибка обновления состояния:", err);
    }
  }

  // ==================== Header & Summary Renders ====================
  function renderHeader() {
    // 1. GitHub Indicator
    const ghDot = $("ind-github-dot");
    const ghText = $("ind-github-text");
    const hasRepo = Boolean(state.settings.repo);
    const lastErr = (state.status?.last_error || "").toLowerCase();
    const isRevoked = lastErr.includes("отозван") || lastErr.includes("revoked");

    if (isRevoked) {
      ghDot.className = "indicator-dot dot-red";
      ghText.textContent = "GitHub (доступ отозван, подключите заново)";
      $("ind-github").title = "Доступ отозван на стороне GitHub. Подключите заново в настройках.";
    } else if (!state.has_github_token) {
      ghDot.className = "indicator-dot dot-gray";
      ghText.textContent = "GitHub (не настроен)";
      $("ind-github").title = "GitHub не подключён. Нажмите, чтобы открыть настройки.";
    } else if (hasRepo) {
      ghDot.className = "indicator-dot dot-green";
      ghText.textContent = `GitHub: ${state.settings.repo}`;
      $("ind-github").title = `Подключён к репозиторию ${state.settings.repo}`;
    } else {
      ghDot.className = "indicator-dot dot-red";
      ghText.textContent = "GitHub (нет репозитория)";
      $("ind-github").title = "GitHub подключён, но репозиторий не выбран";
    }

    // 2. Telegram Indicator
    const tgDot = $("ind-telegram-dot");
    const tgText = $("ind-telegram-text");
    const hasChannel = Boolean(state.settings.channel_id);
    if (!state.has_tg_token) {
      tgDot.className = "indicator-dot dot-gray";
      tgText.textContent = "Telegram (не настроен)";
      $("ind-telegram").title = "Токен Telegram бота не задан";
    } else if (hasChannel) {
      tgDot.className = "indicator-dot dot-green";
      tgText.textContent = `Telegram: ${state.settings.channel_id}`;
      $("ind-telegram").title = `Бот подключён к каналу ${state.settings.channel_id}`;
    } else {
      tgDot.className = "indicator-dot dot-red";
      tgText.textContent = "Telegram (нет канала)";
      $("ind-telegram").title = "Токен бота задан, но канал не привязан";
    }

    // 3. AI Indicator
    const aiDot = $("ind-ai-dot");
    const aiText = $("ind-ai-text");
    const provider = state.settings.ai_provider || "anthropic";
    if (!state.has_ai_key) {
      aiDot.className = "indicator-dot dot-gray";
      aiText.textContent = "ИИ (не настроен)";
      $("ind-ai").title = "Ключ ИИ не задан";
    } else {
      aiDot.className = "indicator-dot dot-green";
      aiText.textContent = `ИИ: ${provider}`;
      $("ind-ai").title = `Провайдер ${provider} подключён`;
    }

    // Header Mode Toggle
    const currentMode = state.settings.mode || "approve";
    $("mode-btn-approve").classList.toggle("active", currentMode === "approve");
    $("mode-btn-auto").classList.toggle("active", currentMode === "auto");

    // Browser Tab Title
    const drafts = state.counts.draft || 0;
    document.title = drafts > 0 ? `(${drafts}) Анонсы из коммитов` : "Анонсы из коммитов";
    $("tab-badge-posts").textContent = drafts > 0 ? String(drafts) : "";
  }

  function renderSummary() {
    $("sum-waiting").textContent = state.counts.draft || 0;

    // Sent today count
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = state.posts.filter(
      (p) => p.status === "sent" && p.sent_at && p.sent_at.startsWith(today)
    ).length;
    $("sum-sent-today").textContent = sentToday;

    // Next poll
    const nextPoll = state.next_poll_in ?? 5;
    $("sum-next-poll").textContent = `${nextPoll} мин`;

    // Debounce pause
    if (state.debounce_until) {
      const remainingSec = Math.max(0, Math.floor((new Date(state.debounce_until) - new Date()) / 1000));
      if (remainingSec > 0) {
        const remainingMin = Math.ceil(remainingSec / 60);
        $("sum-debounce").textContent = `${remainingMin} мин`;
        $("sum-debounce-item").style.display = "inline";
      } else {
        $("sum-debounce-item").style.display = "none";
      }
    } else {
      $("sum-debounce-item").style.display = "none";
    }
  }

  function renderFilters() {
    const c = state.counts;
    $("filter-count-all").textContent = c.total || 0;
    $("filter-count-draft").textContent = c.draft || 0;
    $("filter-count-sent").textContent = c.sent || 0;
    $("filter-count-skipped").textContent = c.skipped || 0;
    $("filter-count-failed").textContent = c.failed || 0;

    $$(".filter-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === state.currentFilter);
    });
  }

  // ==================== Onboarding Checklist ====================
  function renderOnboarding() {
    const card = $("onboarding-card");
    const step1Done = state.has_github_token && Boolean(state.settings.repo);
    const step2Done = state.has_tg_token && Boolean(state.settings.channel_id);
    const step3Done = state.has_ai_key;
    const step4Done = (state.settings.test_post_sent === "1") || (state.counts.sent > 0);

    const completed = [step1Done, step2Done, step3Done, step4Done].filter(Boolean).length;

    if (completed === 4) {
      card.style.display = "none";
      return;
    }

    card.style.display = "block";
    $("onboarding-progress").textContent = `Выполнено ${completed} из 4 шагов`;

    updateStepUI("step-1", step1Done);
    updateStepUI("step-2", step2Done);
    updateStepUI("step-3", step3Done);
    updateStepUI("step-4", step4Done);
  }

  function updateStepUI(stepId, isDone) {
    const el = $(stepId);
    if (!el) return;
    const num = el.querySelector(".step-num");
    const btn = el.querySelector(".step-action-btn");
    if (isDone) {
      num.classList.add("done");
      num.innerHTML = "✓";
      if (btn) btn.style.display = "none";
    } else {
      num.classList.remove("done");
      num.innerHTML = stepId.replace("step-", "");
      if (btn) btn.style.display = "inline-flex";
    }
  }

  // ==================== Feed Rendering ====================
  function renderFeed() {
    const container = $("posts-list");
    const emptyState = $("posts-empty");
    const loadMoreBox = $("load-more-box");

    // If active editing element is currently focused, do not reconstruct its DOM
    const focusedEl = document.activeElement;
    const activeEditingPostId = focusedEl && focusedEl.classList.contains("post-textarea")
      ? focusedEl.dataset.id
      : null;

    if (!state.posts || state.posts.length === 0) {
      container.innerHTML = "";
      emptyState.style.display = "block";
      loadMoreBox.style.display = "none";
      return;
    }

    emptyState.style.display = "none";
    loadMoreBox.style.display = state.hasMore ? "block" : "none";

    // If an element is focused, we surgically preserve it
    const existingCards = new Map();
    container.querySelectorAll(".post-card").forEach((c) => {
      if (c.dataset.id) existingCards.set(c.dataset.id, c);
    });

    const frag = document.createDocumentFragment();

    state.posts.forEach((post) => {
      if (activeEditingPostId && String(post.id) === String(activeEditingPostId) && existingCards.has(String(post.id))) {
        frag.appendChild(existingCards.get(String(post.id)));
      } else {
        frag.appendChild(createPostCard(post));
      }
    });

    container.innerHTML = "";
    container.appendChild(frag);
  }

  function createPostCard(post) {
    const card = document.createElement("article");
    card.className = "post-card";
    card.dataset.id = post.id;

    // Header
    const header = document.createElement("div");
    header.className = "post-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "post-header-left";

    const idSpan = document.createElement("span");
    idSpan.className = "post-id";
    idSpan.textContent = `#${post.id}`;

    const badge = document.createElement("span");
    badge.className = `post-badge badge-${post.status}`;
    const statusLabels = {
      draft: "Черновик",
      sent: "Отправлен",
      sending: "Отправляется...",
      failed: "Ошибка",
      skipped: "Пропущен ИИ",
      rejected: "Отклонён",
    };
    badge.textContent = statusLabels[post.status] || post.status;

    headerLeft.appendChild(idSpan);
    headerLeft.appendChild(badge);

    const time = document.createElement("time");
    time.className = "post-time";
    time.textContent = timeAgo(post.created_at);
    time.title = fullDateTime(post.created_at);

    header.appendChild(headerLeft);
    header.appendChild(time);
    card.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "post-body";

    // Parse Input for "Что изменилось" block
    let parsedInput = null;
    try {
      if (post.input) parsedInput = JSON.parse(post.input);
    } catch (e) {
      // not JSON
    }

    if (post.status === "draft") {
      // Draft Editor
      const textarea = document.createElement("textarea");
      textarea.className = "post-textarea";
      textarea.dataset.id = post.id;
      textarea.value = post.text || "";
      textarea.placeholder = "Текст поста...";
      textarea.rows = 4;

      const footer = document.createElement("div");
      footer.className = "textarea-footer";

      const shortcutHint = document.createElement("span");
      shortcutHint.textContent = "Ctrl + Enter для быстрой публикации";

      const counter = document.createElement("span");
      counter.className = "char-counter";
      const updateCounter = () => {
        const len = textarea.value.length;
        counter.textContent = `${len} / 4096`;
        counter.classList.toggle("warning", len > 800 && len <= 4096);
        counter.classList.toggle("danger", len > 4096);
        textarea.classList.toggle("warn", len > 800 && len <= 4096);
        textarea.classList.toggle("error", len > 4096);
        // Live update Telegram preview
        if (previewBubble) previewBubble.textContent = textarea.value;
      };

      textarea.addEventListener("input", updateCounter);
      textarea.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          publishBtn.click();
        }
      });

      footer.appendChild(shortcutHint);
      footer.appendChild(counter);

      body.appendChild(textarea);
      body.appendChild(footer);

      // Telegram Live Preview Bubble
      const previewBox = document.createElement("div");
      previewBox.className = "tg-preview";
      const previewTitle = document.createElement("div");
      previewTitle.className = "tg-preview-title";
      previewTitle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg> Так увидят подписчики`;
      const previewBubble = document.createElement("div");
      previewBubble.className = "tg-bubble";
      previewBubble.textContent = post.text || "";
      previewBox.appendChild(previewTitle);
      previewBox.appendChild(previewBubble);
      body.appendChild(previewBox);

      updateCounter();

      // Actions Row
      const actions = document.createElement("div");
      actions.className = "post-actions";

      const publishBtn = document.createElement("button");
      publishBtn.className = "btn btn-primary";
      publishBtn.textContent = "Опубликовать";
      publishBtn.addEventListener("click", () => {
        const text = textarea.value.trim();
        if (!text) {
          showToast("Текст поста не может быть пустым", "error");
          return;
        }
        if (text.length > 4096) {
          showToast("Текст превышает 4096 символов. Сократите перед отправкой.", "error");
          return;
        }
        withButton(publishBtn, async () => {
          try {
            await api(`/api/posts/${post.id}/publish`, { method: "POST", body: { text } });
            showToast("Пост успешно опубликован в канал!");
            await loadState();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });

      const regenBtn = document.createElement("button");
      regenBtn.className = "btn btn-secondary";
      regenBtn.textContent = "Другой вариант";
      regenBtn.addEventListener("click", () => {
        withButton(regenBtn, async () => {
          try {
            await api(`/api/posts/${post.id}/regen`, { method: "POST", body: { force: 1 } });
            showToast("Генерируется новый вариант...");
            await loadState();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.className = "btn btn-danger";
      rejectBtn.textContent = "Отклонить";
      rejectBtn.addEventListener("click", () => {
        withButton(rejectBtn, async () => {
          try {
            await api(`/api/posts/${post.id}/reject`, { method: "POST" });
            showToast("Черновик отклонён");
            await loadState();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });

      actions.appendChild(publishBtn);
      actions.appendChild(regenBtn);
      actions.appendChild(rejectBtn);
      body.appendChild(actions);

    } else if (post.status === "sent") {
      // Sent Post Bubble
      const previewBubble = document.createElement("div");
      previewBubble.className = "tg-bubble";
      previewBubble.textContent = post.text || "";
      const bubbleFooter = document.createElement("div");
      bubbleFooter.className = "tg-bubble-footer";
      bubbleFooter.textContent = post.sent_at ? `Отправлено: ${fullDateTime(post.sent_at)}` : "Отправлено";
      previewBubble.appendChild(bubbleFooter);
      body.appendChild(previewBubble);

      const actions = document.createElement("div");
      actions.className = "post-actions";

      // Channel Link
      const channelId = state.settings.channel_id || "";
      if (channelId.startsWith("@") && post.tg_message_id) {
        const link = document.createElement("a");
        link.className = "sent-link";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.href = `https://t.me/${channelId.replace("@", "")}/${post.tg_message_id}`;
        link.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg> Открыть в канале`;
        actions.appendChild(link);
      }

      // Delete From Channel Button
      if (post.tg_message_id) {
        const delChannelBtn = document.createElement("button");
        delChannelBtn.className = "btn btn-danger btn-sm";
        delChannelBtn.textContent = "Удалить из канала";
        delChannelBtn.addEventListener("click", () => {
          if (!confirm("Вы уверены, что хотите удалить это сообщение из канала Telegram?")) return;
          withButton(delChannelBtn, async () => {
            try {
              await api(`/api/posts/${post.id}/delete-from-channel`, { method: "POST" });
              showToast("Пост удалён из канала Telegram");
              await loadState();
            } catch (err) {
              showToast(err.message, "error");
            }
          });
        });
        actions.appendChild(delChannelBtn);
      }

      body.appendChild(actions);

    } else if (post.status === "failed") {
      // Error Banner
      const errBanner = document.createElement("div");
      errBanner.className = "error-banner";
      errBanner.innerHTML = `<span>⚠️ ${post.error || "Произошла ошибка при обработке поста"}</span>`;

      const retryBtn = document.createElement("button");
      retryBtn.className = "btn btn-danger btn-sm";
      retryBtn.textContent = "Повторить";
      retryBtn.addEventListener("click", () => {
        withButton(retryBtn, async () => {
          try {
            await api(`/api/posts/${post.id}/publish`, { method: "POST" });
            showToast("Повторная отправка завершена");
            await loadState();
          } catch (e) {
            try {
              await api(`/api/posts/${post.id}/regen`, { method: "POST", body: { force: 1 } });
              showToast("Повторная генерация запущена");
              await loadState();
            } catch (err) {
              showToast(err.message, "error");
            }
          }
        });
      });
      errBanner.appendChild(retryBtn);
      body.appendChild(errBanner);

    } else if (post.status === "skipped") {
      // Skipped Banner
      const skipBanner = document.createElement("div");
      skipBanner.className = "skipped-banner";
      skipBanner.innerHTML = `<span>🤖 ИИ счёл изменения неинтересными для подписчиков</span>`;

      const forceBtn = document.createElement("button");
      forceBtn.className = "btn btn-secondary btn-sm";
      forceBtn.textContent = "Всё равно написать";
      forceBtn.addEventListener("click", () => {
        withButton(forceBtn, async () => {
          try {
            await api(`/api/posts/${post.id}/regen`, { method: "POST", body: { force: 1 } });
            showToast("Создаём черновик поста...");
            await loadState();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });
      skipBanner.appendChild(forceBtn);
      body.appendChild(skipBanner);
    }

    // Collapsible "Что изменилось" block
    if (parsedInput) {
      const details = document.createElement("details");
      details.className = "diff-details";

      const commitsCount = parsedInput.commits?.length || 0;
      const filesCount = parsedInput.files?.length || 0;

      const summary = document.createElement("summary");
      summary.className = "diff-summary";
      summary.textContent = `Что изменилось (${commitsCount} коммит${getRussianPlural(commitsCount, "", "а", "ов")}, ${filesCount} файл${getRussianPlural(filesCount, "", "а", "ов")})`;

      const diffContent = document.createElement("div");
      diffContent.className = "diff-content";

      if (parsedInput.commits && parsedInput.commits.length > 0) {
        const commitsList = document.createElement("div");
        commitsList.className = "commits-list";
        parsedInput.commits.forEach((c) => {
          const item = document.createElement("div");
          item.className = "commit-item";
          const hash = document.createElement("span");
          hash.className = "commit-hash";
          hash.textContent = (c.sha || "").slice(0, 7);
          const msg = document.createElement("span");
          msg.className = "commit-msg";
          msg.textContent = c.message || "";
          item.appendChild(hash);
          item.appendChild(msg);
          commitsList.appendChild(item);
        });
        diffContent.appendChild(commitsList);
      }

      if (parsedInput.files && parsedInput.files.length > 0) {
        const filesTags = document.createElement("div");
        filesTags.className = "files-tags";
        parsedInput.files.forEach((f) => {
          const tag = document.createElement("span");
          tag.className = "file-tag";
          tag.textContent = typeof f === "string" ? f : f.filename || "";
          filesTags.appendChild(tag);
        });
        diffContent.appendChild(filesTags);
      }

      details.appendChild(summary);
      details.appendChild(diffContent);
      body.appendChild(details);
    }

    card.appendChild(body);
    return card;
  }

  function getRussianPlural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 19) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  // ==================== Settings Forms & Handlers ====================
  function populateSettingsForms() {
    const s = state.settings;

    // GitHub
    populateGitHubAppPane();
    maskSecretField("github_token", Boolean(s.github_token_set));
    $("branch").value = s.branch || "main";
    initRepoSelect(s.repo || "");

    // Telegram
    maskSecretField("tg_token", state.has_tg_token);
    $("channel_id").value = s.channel_id || "";
    renderOwnerStatus(s.tg_owner_chat_id, s.tg_owner_username);

    // AI
    $("ai_provider").value = s.ai_provider || "anthropic";
    maskSecretField("ai_key", state.has_ai_key);
    $("ai_model").value = s.ai_model || "";
    updateAiProviderUI();

    // Behavior
    const mode = s.mode || "approve";
    $("mode").value = mode;
    $("poll_interval").value = s.poll_interval || "5";
    $("debounce_pause").value = s.debounce_pause || "10";
    $("tone").value = s.tone || "";
    $("tg_notify_drafts").checked = s.tg_notify_drafts === "1";
    updateDigestFieldsVisibility(mode);

    // Security
    const encPill = $("enc-status-pill");
    if (state.encryption_enabled) {
      encPill.className = "status-pill enabled";
      encPill.textContent = "Шифрование включено (ENCRYPTION_KEY активен)";
    } else {
      encPill.className = "status-pill disabled";
      encPill.textContent = "Шифрование выключено (хранение в открытом виде)";
    }
  }

  function populateGitHubAppPane() {
    const ghConnectPane = $("gh-app-connect-pane");
    const ghConnectedPane = $("gh-app-connected-pane");
    const btnGhConnect = $("btn-gh-app-connect");
    const btnGhDisabled = $("btn-gh-app-disabled");
    const ghHint = $("gh-app-hint");
    const manualDetails = $("manual-token-details");

    if (state.github_installation_id) {
      if (ghConnectPane) ghConnectPane.style.display = "none";
      if (ghConnectedPane) ghConnectedPane.style.display = "block";
      const loginEl = $("gh-app-connected-login");
      if (loginEl) loginEl.textContent = state.github_account_login || "подключён";
      const manageBtn = $("btn-gh-app-manage");
      if (manageBtn) manageBtn.href = `https://github.com/settings/installations/${state.github_installation_id}`;
      if (manualDetails && !state.unmaskedSecrets.has("github_token") && !state.settings.github_token_set) {
        manualDetails.open = false;
      }
    } else {
      if (ghConnectedPane) ghConnectedPane.style.display = "none";
      if (ghConnectPane) ghConnectPane.style.display = "block";
      if (state.github_app_configured) {
        if (btnGhConnect) btnGhConnect.style.display = "inline-flex";
        if (btnGhDisabled) btnGhDisabled.style.display = "none";
        if (ghHint) ghHint.textContent = "";
      } else {
        if (btnGhConnect) btnGhConnect.style.display = "none";
        if (btnGhDisabled) btnGhDisabled.style.display = "inline-flex";
        if (ghHint) ghHint.textContent = "Приложение GitHub не настроено, см. README";
      }
      if (manualDetails && (state.settings.github_token_set || state.unmaskedSecrets.has("github_token"))) {
        manualDetails.open = true;
      }
    }
  }

  function maskSecretField(fieldName, hasSecret) {
    const input = $(fieldName);
    const btn = $(`btn-change-${fieldName}`);
    if (!input) return;

    if (hasSecret && !state.unmaskedSecrets.has(fieldName)) {
      input.type = "text";
      input.value = "••••••••, сохранён";
      input.disabled = true;
      input.classList.add("secret-masked");
      if (btn) btn.style.display = "inline-flex";
    } else {
      input.disabled = false;
      input.classList.remove("secret-masked");
      if (!state.unmaskedSecrets.has(fieldName)) {
        input.value = "";
      }
      input.placeholder = "Вставьте токен или ключ";
      if (btn) btn.style.display = "none";
    }
  }

  function unmaskSecretField(fieldName) {
    state.unmaskedSecrets.add(fieldName);
    const input = $(fieldName);
    const btn = $(`btn-change-${fieldName}`);
    if (input) {
      input.disabled = false;
      input.classList.remove("secret-masked");
      input.value = "";
      input.focus();
    }
    if (btn) btn.style.display = "none";
  }

  async function initRepoSelect(currentRepo) {
    const select = $("repo-select");
    if (!select) return;

    if (!state.has_github_token && !state.github_installation_id) {
      select.innerHTML = '<option value="">Сначала подключите GitHub</option>';
      return;
    }

    try {
      const data = await api("/api/repos");
      const repos = Array.isArray(data) ? data : (data.repos || []);
      select.innerHTML = '<option value="">-- Выберите репозиторий --</option>';
      if (repos.length === 0) {
        select.innerHTML = '<option value="">Репозитории не найдены (проверьте доступ)</option>';
      } else {
        repos.forEach((r) => {
          const repoName = r.name || r.full_name;
          const repoBranch = r.branch || r.default_branch || "main";
          const opt = document.createElement("option");
          opt.value = repoName;
          opt.textContent = `${repoName} (${repoBranch})`;
          opt.dataset.branch = repoBranch;
          if (repoName === currentRepo) opt.selected = true;
          select.appendChild(opt);
        });
      }

      const countEl = $("gh-app-connected-count");
      if (countEl) countEl.textContent = repos.length;

      select.onchange = () => {
        const selectedOpt = select.selectedOptions[0];
        if (selectedOpt && selectedOpt.dataset.branch) {
          $("branch").value = selectedOpt.dataset.branch;
        }
      };
    } catch (err) {
      select.innerHTML = `<option value="">Ошибка загрузки: ${err.message}</option>`;
    }
  }

  function renderOwnerStatus(chatId, username) {
    const info = $("owner-chat-info");
    const resetBtn = $("btn-reset-owner");
    if (chatId) {
      info.textContent = `Запомнен: ${username || chatId} (ID: ${chatId})`;
      if (resetBtn) resetBtn.style.display = "inline-flex";
    } else {
      info.textContent = "Владелец ещё не назначен. Откройте диалог с ботом и нажмите /start";
      if (resetBtn) resetBtn.style.display = "none";
    }
  }

  function updateAiProviderUI() {
    const provider = $("ai_provider").value;
    const datalist = $("ai-models-list");
    const hint = $("ai-model-hint");
    if (provider === "anthropic") {
      datalist.innerHTML = `
        <option value="claude-sonnet-5-5">
        <option value="claude-haiku-5-5">
        <option value="claude-opus-5-5">
      `;
      hint.textContent = "Рекомендуемые модели: claude-sonnet-5-5, claude-haiku-5-5";
    } else {
      datalist.innerHTML = `
        <option value="gpt-4o">
        <option value="gpt-4o-mini">
      `;
      hint.textContent = "Укажите название модели из вашего кабинета OpenAI (например, gpt-4o)";
    }
  }

  function updateDigestFieldsVisibility(mode) {
    const digestGroup = $("digest-settings-group");
    if (digestGroup) {
      digestGroup.style.display = mode === "digest" ? "flex" : "none";
    }
  }

  // ==================== Attach All Event Listeners ====================
  function initEvents() {
    // 1. Navigation Tabs
    $$(".nav-tab").forEach((tab) => {
      tab.addEventListener("click", () => setTab(tab.dataset.tab));
    });

    // 2. Settings Nav Buttons
    $$(".settings-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => setSettingsSection(btn.dataset.section));
    });

    // 3. Header Action Buttons
    $("btn-header-check").addEventListener("click", () => {
      withButton($("btn-header-check"), async () => {
        try {
          const res = await api("/api/check?force=1", { method: "POST" });
          showToast(res.message || "Проверка запущена");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    $("login-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const pwInput = $("pw");
      const errBox = $("login-error");
      const submitBtn = $("go");
      const password = (pwInput?.value || "").trim();
      if (!password) return;

      withButton(submitBtn, async () => {
        try {
          const res = await fetch("/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            errBox.textContent = data.error || "Неверный пароль";
            errBox.style.display = "block";
            pwInput.select();
            return;
          }
          errBox.style.display = "none";
          hideLogin();
          await loadState(true);
        } catch (err) {
          errBox.textContent = err.message || "Ошибка соединения";
          errBox.style.display = "block";
        }
      });
    });

    $("btn-header-logout")?.addEventListener("click", async () => {
      try {
        await api("/logout", { method: "POST" });
      } finally {
        showLogin();
      }
    });

    // Header Mode Buttons
    $("mode-btn-approve").addEventListener("click", async () => {
      try {
        await api("/api/settings", { method: "POST", body: { mode: "approve" } });
        showToast("Режим переключен: Спрашивать меня");
        await loadState();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    $("mode-btn-auto").addEventListener("click", async () => {
      try {
        await api("/api/settings", { method: "POST", body: { mode: "auto" } });
        showToast("Режим переключен: Публиковать сразу");
        await loadState();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // 4. Indicator clicks -> jump to section
    $("ind-github").addEventListener("click", (e) => {
      e.preventDefault();
      setTab("settings");
      setSettingsSection("github");
    });
    $("ind-telegram").addEventListener("click", (e) => {
      e.preventDefault();
      setTab("settings");
      setSettingsSection("telegram");
    });
    $("ind-ai").addEventListener("click", (e) => {
      e.preventDefault();
      setTab("settings");
      setSettingsSection("ai");
    });

    // 5. Filter Chips
    $$(".filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.currentFilter = chip.dataset.filter;
        renderFilters();
        loadState();
      });
    });

    // 6. Onboarding buttons
    $("btn-onboard-github")?.addEventListener("click", () => {
      setTab("settings");
      setSettingsSection("github");
    });
    $("btn-onboard-telegram")?.addEventListener("click", () => {
      setTab("settings");
      setSettingsSection("telegram");
    });
    $("btn-onboard-ai")?.addEventListener("click", () => {
      setTab("settings");
      setSettingsSection("ai");
    });
    $("btn-onboard-test")?.addEventListener("click", () => {
      withButton($("btn-onboard-test"), async () => {
        try {
          await api("/api/test/channel-post", { method: "POST" });
          showToast("Тестовый пост успешно отправлен в канал!");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    // 7. Load More Button
    $("btn-load-more")?.addEventListener("click", () => {
      withButton($("btn-load-more"), async () => {
        state.limit += 15;
        await loadState();
      });
    });

    // 8. Empty State Check Button
    $("btn-empty-check")?.addEventListener("click", () => {
      $("btn-header-check").click();
    });

    // 9. Secret Unmask Buttons
    $("btn-change-github_token")?.addEventListener("click", () => unmaskSecretField("github_token"));
    $("btn-change-tg_token")?.addEventListener("click", () => unmaskSecretField("tg_token"));
    $("btn-change-ai_key")?.addEventListener("click", () => unmaskSecretField("ai_key"));

    // 10. AI Provider Select Change
    $("ai_provider")?.addEventListener("change", updateAiProviderUI);

    // 11. Mode Select Change in Behavior
    $("mode")?.addEventListener("change", (e) => updateDigestFieldsVisibility(e.target.value));

    // 12. Tone Preset Buttons
    $$(".preset-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        $("tone").value = btn.dataset.prompt || "";
        showToast("Стиль подставлен в поле!");
      });
    });

    // 13. GitHub App Disconnect & Save & Test
    $("btn-gh-app-disconnect")?.addEventListener("click", () => {
      if (!confirm("Отключить GitHub App? В панели будет удалена сохранённая привязка установки.")) return;
      withButton($("btn-gh-app-disconnect"), async () => {
        try {
          await api("/api/github/disconnect", { method: "POST" });
          showToast("GitHub отключён. Полностью отозвать доступ можно на странице установки GitHub.");
          await loadState();
          populateSettingsForms();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    $("btn-save-github")?.addEventListener("click", () => {
      withButton($("btn-save-github"), async () => {
        const payload = {
          branch: $("branch").value.trim(),
          repo: $("repo-select")?.value || "",
        };
        if (state.unmaskedSecrets.has("github_token")) {
          payload.github_token = $("github_token").value.trim();
        }
        try {
          await api("/api/settings", { method: "POST", body: payload });
          showToast("Настройки GitHub сохранены");
          state.unmaskedSecrets.delete("github_token");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    $("btn-test-github")?.addEventListener("click", () => {
      const resBox = $("test-result-github");
      withButton($("btn-test-github"), async () => {
        try {
          const res = await api("/api/test/github", { method: "POST" });
          resBox.className = "test-result-box active success";
          resBox.textContent = `✓ ${res.message || `Подключено как ${res.user}${res.repo ? ` (репозиторий: ${res.repo})` : ""}`}`;
        } catch (err) {
          resBox.className = "test-result-box active error";
          resBox.textContent = `✗ ${err.message}`;
        }
      });
    });

    // 14. Save & Test Telegram
    $("btn-save-telegram")?.addEventListener("click", () => {
      withButton($("btn-save-telegram"), async () => {
        const payload = {
          channel_id: $("channel_id").value.trim(),
        };
        if (state.unmaskedSecrets.has("tg_token")) {
          payload.tg_token = $("tg_token").value.trim();
        }
        try {
          await api("/api/settings", { method: "POST", body: payload });
          showToast("Настройки Telegram сохранены");
          state.unmaskedSecrets.delete("tg_token");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    $("btn-test-telegram")?.addEventListener("click", () => {
      const resBox = $("test-result-telegram");
      withButton($("btn-test-telegram"), async () => {
        try {
          const res = await api("/api/test/telegram", { method: "POST" });
          resBox.className = "test-result-box active success";
          resBox.textContent = `✓ Бот @${res.bot || "бот"}${res.channel ? `, администратор канала ${res.channel}` : ""}`;
        } catch (err) {
          resBox.className = "test-result-box active error";
          resBox.textContent = `✗ ${err.message}`;
        }
      });
    });

    $("btn-test-channel-post")?.addEventListener("click", () => {
      withButton($("btn-test-channel-post"), async () => {
        try {
          await api("/api/test/channel-post", { method: "POST" });
          showToast("Тестовый пост успешно отправлен в канал!");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    $("btn-reset-owner")?.addEventListener("click", () => {
      if (!confirm("Сбросить привязанного владельца? Первый пользователь, написавший /start боту, станет новым владельцем.")) return;
      withButton($("btn-reset-owner"), async () => {
        try {
          await api("/api/test/reset-owner", { method: "POST" });
          showToast("Владелец бота сброшен");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    // 15. Save & Test AI
    $("btn-save-ai")?.addEventListener("click", () => {
      withButton($("btn-save-ai"), async () => {
        const payload = {
          ai_provider: $("ai_provider").value,
          ai_model: $("ai_model").value.trim(),
        };
        if (state.unmaskedSecrets.has("ai_key")) {
          payload.ai_key = $("ai_key").value.trim();
        }
        try {
          await api("/api/settings", { method: "POST", body: payload });
          showToast("Настройки ИИ сохранены");
          state.unmaskedSecrets.delete("ai_key");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    $("btn-test-ai")?.addEventListener("click", () => {
      const resBox = $("test-result-ai");
      withButton($("btn-test-ai"), async () => {
        try {
          const res = await api("/api/test/ai", { method: "POST" });
          const sec = (res.duration_ms ? res.duration_ms / 1000 : 1.2).toFixed(1);
          resBox.className = "test-result-box active success";
          resBox.textContent = `✓ Ответ получен за ${sec} с`;
        } catch (err) {
          resBox.className = "test-result-box active error";
          resBox.textContent = `✗ ${err.message}`;
        }
      });
    });

    // 16. Save Behavior
    $("btn-save-behavior")?.addEventListener("click", () => {
      withButton($("btn-save-behavior"), async () => {
        const payload = {
          mode: $("mode").value,
          poll_interval: $("poll_interval").value.trim(),
          debounce_pause: $("debounce_pause").value.trim(),
          tone: $("tone").value.trim(),
          tg_notify_drafts: $("tg_notify_drafts").checked ? "1" : "0",
        };
        try {
          await api("/api/settings", { method: "POST", body: payload });
          showToast("Параметры поведения сохранены");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    // 17. Security: Password Change
    $("btn-change-password")?.addEventListener("click", () => {
      const cur = $("current_password").value;
      const newP = $("new_password").value;
      const confP = $("confirm_password").value;

      if (!cur || !newP || !confP) {
        showToast("Заполните все поля для смены пароля", "error");
        return;
      }
      if (newP !== confP) {
        showToast("Новый пароль и подтверждение не совпадают", "error");
        return;
      }
      if (newP.length < 6) {
        showToast("Новый пароль должен содержать минимум 6 символов", "error");
        return;
      }

      withButton($("btn-change-password"), async () => {
        try {
          await api("/api/password", {
            method: "POST",
            body: { current_password: cur, new_password: newP, confirm_password: confP },
          });
          $("current_password").value = "";
          $("new_password").value = "";
          $("confirm_password").value = "";
          showToast("Пароль администратора успешно изменён!");
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });

    // 18. Auto-Refresh every 30 seconds
    setInterval(() => {
      loadState(false);
    }, 30000);
  }

  // DOM Loaded Entrypoint
  window.addEventListener("DOMContentLoaded", async () => {
    initEvents();
    await loadState(true);
  });
})();
