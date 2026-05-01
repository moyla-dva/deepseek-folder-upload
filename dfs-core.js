(function () {
  'use strict';

  const MAX_FILES_PER_BATCH = 50;
  const MAX_SIZE = 100 * 1024 * 1024;
  const STORAGE_KEY = 'dfs_uploader_state';
  const ATTACHMENT_TIMEOUT_MIN_MS = 15000;
  const ATTACHMENT_TIMEOUT_MAX_MS = 90000;
  const ATTACHMENT_POLL_MS = 250;
  const SETTLEMENT_POLL_MS = 500;
  const SETTLEMENT_MAX_POLLS = 8;
  const COMPOSER_READY_POLL_MS = 1000;
  const COMPOSER_READY_TIMEOUT_MS = 120000;
  const COMPOSER_READY_STABLE_POLLS = 3;
  const COMPOSER_RECOVERY_COOLDOWN_MS = 4000;
  const AUTO_SEND_READY_TIMEOUT_MS = 90000;
  const AUTO_SEND_POLL_MS = 500;
  const AUTO_CONTEXT_MARKER = '【附件批次上下文】';
  const MIN_BATCH_INTERVAL_SECONDS = 3;
  const MAX_BATCH_INTERVAL_SECONDS = 30;
  const DEFAULT_BATCH_INTERVAL_SECONDS = 5;

  function escapeKeywordRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const KEYWORD_GROUPS = {
    send: [
      '发送', '提交', '送出',
      'send', 'submit', 'send message',
      'enviar', 'envoyer', 'senden', 'invia', '送信'
    ],
    stop: [
      '停止', '中止', '终止', '停止生成', '结束生成',
      'stop', 'abort', 'cancel', 'stop generating', 'end response',
      'parar', 'abbrechen', 'annulla', '停止出力', '生成停止'
    ],
    explicitStop: [
      '停止生成', '结束生成',
      'stop', 'stop generating', 'end response',
      'parar', 'abbrechen', '停止出力', '生成停止'
    ],
    upload: [
      'upload', 'attach', 'attachment', 'file', 'image', 'mic', 'voice', 'plus', 'add',
      '附件', '文件', '图片', '语音', '添加',
      'subir', 'archivo', 'datei', 'anhang', 'uploaden',
      '添付', 'アップロード', 'ファイル'
    ],
    searchExclusion: [
      'search', '搜索', '智能搜索',
      'reason', 'deep think', 'think deeper', 'web search', 'deep search',
      '深度思考', '深度搜索',
      'buscar', 'rechercher', 'suchen', '検索'
    ]
  };

  function createKeywordRegExp(keywords) {
    return new RegExp(`(${keywords.map(escapeKeywordRegExp).join('|')})`, 'i');
  }

  const SEND_KEYWORD_RE = createKeywordRegExp(KEYWORD_GROUPS.send);
  const STOP_KEYWORD_RE = createKeywordRegExp(KEYWORD_GROUPS.stop);
  const EXPLICIT_STOP_KEYWORD_RE = createKeywordRegExp(KEYWORD_GROUPS.explicitStop);
  const UPLOAD_KEYWORD_RE = createKeywordRegExp(KEYWORD_GROUPS.upload);
  const SEARCH_EXCLUSION_KEYWORD_RE = createKeywordRegExp(KEYWORD_GROUPS.searchExclusion);
  const ATTACHMENT_NAME_RE = /\b[^/\n]+\.[a-z0-9]{1,12}\b/i;
  const ATTACHMENT_SIZE_RE = /\b\d+(?:\.\d+)?\s?(?:B|KB|MB|GB)\b/i;
  const ATTACHMENT_ERROR_RE = /(服务器繁忙|server busy|上传失败|上传出错|无法上传|网络错误|network error|重试上传|请重试|稍后再试|try again|upload failed|failed to upload)/i;
  const ATTACHMENT_SERVER_BUSY_RE = /(服务器繁忙|server busy)/i;

  const ATTACHMENT_SELECTORS = [
    '[data-testid*="attachment"]',
    '[data-testid*="upload"]',
    '[data-testid*="file"]',
    '[aria-label*="附件"]',
    '[aria-label*="attachment"]',
    '[class*="attachment"]',
    '[class*="upload-item"]',
    '[class*="file-chip"]',
    '[class*="file-item"]'
  ];

  const DOC_EXTENSIONS = [
    '.pdf', '.doc', '.docx', '.txt', '.md', '.csv', '.xls', '.xlsx',
    '.ppt', '.pptx', '.odt', '.rtf', '.json', '.yaml', '.yml', '.xml',
    '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h',
    '.sql', '.log', '.toml', '.ini', '.cfg', '.tex', '.bib', '.rst', '.rmd'
  ];

  const DOC_MIMES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json'
  ];

  const state = {
    queue: [],
    skipped: [],
    currentBatch: [],
    completedBatches: 0,
    totalBatches: 0,
    uploadMode: 'auto',
    uploadSource: 'folder',
    isPaused: false,
    phase: 'idle',
    errorMessage: '',
    runToken: 0,
    composerBaselineAttachments: 0,
    currentBatchExpectedAttachments: 0,
    currentBatchDetectedAttachments: 0,
    currentBatchAttachmentsConfirmed: false,
    currentBatchUsedAutoContext: false,
    lastSettledBatchSize: 0,
    nextBatchReadyAt: 0,
    sessionBatchSize: 0,
    consecutiveServerBusyCount: 0,
    consecutiveSuccessfulBatches: 0,
    currentBatchLogId: '',
    sessionLogSequence: 0,
    sessionLog: [],
    lastFailureContext: null,
    settleTimerId: null,
    settleCleanup: null,
    advanceTimerId: null,
    cooldownTickerId: null,
    successTimerId: null,
    history: [],
    config: {
      batchSize: 50,
      sendDelay: 0.5,
      batchInterval: DEFAULT_BATCH_INTERVAL_SECONDS,
      customExtensions: [],
      messageTemplate: ''
    }
  };

  const ui = {
    btn: null,
    drawer: null,
    wrapper: null,
    activeTab: 'queue',
    renderSnapshot: null,
    placementTimerId: null,
    placementObserver: null,
    filePickerInput: null,
    filePickerFocusCleanupId: null,
    confirmOverlay: null,
    confirmTitle: null,
    confirmMessage: null,
    confirmCancelBtn: null,
    confirmAcceptBtn: null,
    confirmResolve: null
  };

  const domCache = {
    version: 0,
    invalidationScheduled: false,
    simple: new Map(),
    attachments: new WeakMap()
  };

  function enqueueMicrotask(callback) {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(callback);
      return;
    }
    Promise.resolve().then(callback);
  }

  function normalizeExtension(ext) {
    const value = String(ext || '').trim().toLowerCase();
    if (!value) return '';
    return value.startsWith('.') ? value : `.${value}`;
  }

  function normalizeBatchIntervalSeconds(value, fallback = DEFAULT_BATCH_INTERVAL_SECONDS) {
    const parsed = parseInt(value, 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(MAX_BATCH_INTERVAL_SECONDS, Math.max(MIN_BATCH_INTERVAL_SECONDS, normalized));
  }

  function getConfiguredBatchSize() {
    return Math.min(MAX_FILES_PER_BATCH, Math.max(1, parseInt(state.config.batchSize, 10) || MAX_FILES_PER_BATCH));
  }

  function getEffectiveBatchSize() {
    const configuredBatchSize = getConfiguredBatchSize();
    const sessionBatchSize = Number.isFinite(state.sessionBatchSize) && state.sessionBatchSize > 0
      ? state.sessionBatchSize
      : configuredBatchSize;
    return Math.min(configuredBatchSize, Math.max(1, sessionBatchSize));
  }

  function normalizeAttachmentCount(count) {
    const normalized = Number.isFinite(Number(count)) ? Number(count) : 0;
    return Math.min(MAX_FILES_PER_BATCH, Math.max(0, Math.round(normalized)));
  }

  function getKnownComposerAttachmentCount() {
    if (Number.isFinite(ui.renderSnapshot?.composerAttachmentCount)) {
      return normalizeAttachmentCount(ui.renderSnapshot.composerAttachmentCount);
    }
    return normalizeAttachmentCount(
      typeof shared.getComposerAttachmentCount === 'function'
        ? shared.getComposerAttachmentCount()
        : 0
    );
  }

  function setRenderSnapshot(snapshot = null) {
    if (!snapshot || typeof snapshot !== 'object') {
      ui.renderSnapshot = null;
      return;
    }
    ui.renderSnapshot = { ...snapshot };
  }

  function getAvailableAttachmentSlots(existingAttachments = getKnownComposerAttachmentCount()) {
    return Math.max(0, MAX_FILES_PER_BATCH - normalizeAttachmentCount(existingAttachments));
  }

  function getInjectableBatchSize(existingAttachments = getKnownComposerAttachmentCount(), batchSize = getEffectiveBatchSize()) {
    const safeBatchSize = Math.min(MAX_FILES_PER_BATCH, Math.max(1, parseInt(batchSize, 10) || MAX_FILES_PER_BATCH));
    return Math.min(safeBatchSize, getAvailableAttachmentSlots(existingAttachments));
  }

  function getProjectedBatchCount(fileCount = state.queue.length, options = {}) {
    const pendingCount = Math.max(0, parseInt(fileCount, 10) || 0);
    if (!pendingCount) return 0;

    const batchSize = Math.min(MAX_FILES_PER_BATCH, Math.max(1, parseInt(options.batchSize, 10) || getEffectiveBatchSize()));
    if (options.currentBatchSize != null) {
      const currentBatchSize = Math.max(0, parseInt(options.currentBatchSize, 10) || 0);
      if (!currentBatchSize) return Math.ceil(pendingCount / batchSize);
      if (pendingCount <= currentBatchSize) return 1;
      return 1 + Math.ceil((pendingCount - currentBatchSize) / batchSize);
    }

    const firstBatchCapacity = options.firstBatchCapacity != null
      ? Math.max(0, parseInt(options.firstBatchCapacity, 10) || 0)
      : getInjectableBatchSize(options.existingAttachments, batchSize);

    if (!firstBatchCapacity) return Math.ceil(pendingCount / batchSize);
    if (pendingCount <= firstBatchCapacity) return 1;
    return 1 + Math.ceil((pendingCount - firstBatchCapacity) / batchSize);
  }

  function invalidateDomCache() {
    domCache.invalidationScheduled = false;
    domCache.version += 1;
    domCache.simple.clear();
    domCache.attachments = new WeakMap();
  }

  function scheduleDomCacheInvalidation() {
    if (domCache.invalidationScheduled) return;
    domCache.invalidationScheduled = true;
    enqueueMicrotask(() => {
      if (!domCache.invalidationScheduled) return;
      invalidateDomCache();
    });
  }

  function getCachedDomValue(key, compute) {
    const cached = domCache.simple.get(key);
    if (cached && cached.version === domCache.version) {
      return cached.value;
    }

    const value = compute();
    domCache.simple.set(key, { version: domCache.version, value });
    return value;
  }

  function getCachedAttachmentElements(root, compute) {
    if (!(root instanceof HTMLElement)) return [];

    const cached = domCache.attachments.get(root);
    if (cached && cached.version === domCache.version) {
      return cached.value;
    }

    const value = compute();
    domCache.attachments.set(root, { version: domCache.version, value });
    return value;
  }

  function hasCurrentBatch() {
    return state.currentBatch.length > 0;
  }

  function isBatchVisible() {
    return hasCurrentBatch() && ['injecting', 'awaiting_send', 'sending', 'paused', 'error'].includes(state.phase);
  }

  function isBusyPhase() {
    return ['injecting', 'sending'].includes(state.phase);
  }

  function hasPendingWork() {
    return state.queue.length > 0 || isBatchVisible();
  }

  function getPendingCount() {
    if (queueStartsWithCurrentBatch()) return state.queue.length;
    return state.queue.length + (hasCurrentBatch() ? state.currentBatch.length : 0);
  }

  function queueStartsWithCurrentBatch() {
    if (!hasCurrentBatch() || state.queue.length < state.currentBatch.length) return false;
    return state.currentBatch.every((item, index) => state.queue[index] === item);
  }

  function getQueuedItemsAfterCurrentBatch() {
    return queueStartsWithCurrentBatch()
      ? state.queue.slice(state.currentBatch.length)
      : state.queue.slice();
  }

  function getQueuedCountAfterCurrentBatch() {
    return getQueuedItemsAfterCurrentBatch().length;
  }

  function getCurrentBatchNumber() {
    if (!state.totalBatches) return 0;
    if (hasCurrentBatch()) return Math.min(state.completedBatches + 1, state.totalBatches);
    if (state.queue.length) return Math.min(state.completedBatches + 1, state.totalBatches);
    return Math.min(state.completedBatches, state.totalBatches);
  }

  function getProgressPercent() {
    return state.totalBatches ? (state.completedBatches / state.totalBatches) * 100 : 0;
  }

  function clearSettlementTimer() {
    if (state.settleTimerId) {
      clearTimeout(state.settleTimerId);
      clearInterval(state.settleTimerId);
      state.settleTimerId = null;
    }
    if (state.settleCleanup) {
      state.settleCleanup();
      state.settleCleanup = null;
    }
  }

  function clearAdvanceTimer() {
    if (state.advanceTimerId) {
      clearTimeout(state.advanceTimerId);
      state.advanceTimerId = null;
    }
    if (state.cooldownTickerId) {
      clearInterval(state.cooldownTickerId);
      state.cooldownTickerId = null;
    }
  }

  function clearSuccessTimer() {
    if (state.successTimerId) {
      clearTimeout(state.successTimerId);
      state.successTimerId = null;
    }
  }

  function clearAllTimers() {
    clearSettlementTimer();
    clearAdvanceTimer();
    clearSuccessTimer();
  }

  function resetBatchAttachmentStatus() {
    state.currentBatchExpectedAttachments = 0;
    state.currentBatchDetectedAttachments = 0;
    state.currentBatchAttachmentsConfirmed = false;
    state.currentBatchUsedAutoContext = false;
  }

  function restoreCurrentBatchToQueue() {
    if (!hasCurrentBatch()) return;
    if (!queueStartsWithCurrentBatch()) {
      state.queue = state.currentBatch.concat(state.queue);
    }
    state.currentBatch = [];
    resetBatchAttachmentStatus();
  }

  function bumpRunToken() {
    state.runToken += 1;
    return state.runToken;
  }

  function refreshTotalBatches() {
    const batchSize = getEffectiveBatchSize();
    if (!state.queue.length && !hasCurrentBatch() && state.completedBatches === 0) {
      state.totalBatches = 0;
      return;
    }
    state.totalBatches = state.completedBatches + (
      queueStartsWithCurrentBatch()
        ? getProjectedBatchCount(state.queue.length, {
          batchSize,
          currentBatchSize: state.currentBatch.length
        })
        : hasCurrentBatch()
          ? 1 + Math.ceil(state.queue.length / batchSize)
          : getProjectedBatchCount(state.queue.length, { batchSize })
    );
  }

  function rememberHistory(acceptedCount, skippedCount) {
    if (!acceptedCount && !skippedCount) return;
    state.history.unshift({
      at: new Date().toISOString(),
      source: state.uploadSource,
      acceptedCount,
      skippedCount,
      batches: getProjectedBatchCount(acceptedCount)
    });
    state.history = state.history.slice(0, 5);
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        uploadMode: state.uploadMode,
        uploadSource: state.uploadSource,
        config: {
          ...state.config,
          batchSize: Math.min(MAX_FILES_PER_BATCH, Math.max(1, parseInt(state.config.batchSize, 10) || MAX_FILES_PER_BATCH)),
          batchInterval: normalizeBatchIntervalSeconds(state.config.batchInterval),
          customExtensions: state.config.customExtensions.map(normalizeExtension).filter(Boolean)
        },
        history: state.history.slice(0, 5)
      }));
    } catch (error) {
      console.warn('[DFS Uploader] 保存本地配置失败。', error);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state.uploadMode = saved.uploadMode || 'auto';
      state.uploadSource = saved.uploadSource || 'folder';
      state.config = { ...state.config, ...(saved.config || {}) };
      state.config.batchSize = Math.min(MAX_FILES_PER_BATCH, Math.max(1, parseInt(state.config.batchSize, 10) || MAX_FILES_PER_BATCH));
      state.config.batchInterval = normalizeBatchIntervalSeconds(state.config.batchInterval, DEFAULT_BATCH_INTERVAL_SECONDS);
      state.config.customExtensions = (state.config.customExtensions || []).map(normalizeExtension).filter(Boolean);
      state.history = Array.isArray(saved.history) ? saved.history : [];
    } catch (error) {
      console.warn('[DFS Uploader] 读取本地配置失败，已回退到默认配置。', error);
    }
  }

  function isAllowedFile(file) {
    if (file.size > MAX_SIZE) return false;
    if (file.type && file.type.startsWith('image/')) return true;
    if (DOC_MIMES.includes(file.type)) return true;
    const lower = file.name.toLowerCase();
    return DOC_EXTENSIONS.some(ext => lower.endsWith(ext)) ||
      state.config.customExtensions.some(ext => lower.endsWith(ext));
  }

  function getRejectReason(file) {
    if (file.size > MAX_SIZE) return '超过 100MB';
    return '类型不支持';
  }

  function classifyFiles(files) {
    const queue = [];
    const skipped = [];
    for (const file of files) {
      if (isAllowedFile(file)) {
        queue.push({ name: file.name, size: file.size, type: file.type, file });
      } else {
        skipped.push({ name: file.name, size: file.size, type: file.type, file, reason: getRejectReason(file) });
      }
    }
    return { queue, skipped };
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getFileKind(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.xls') || lower.endsWith('.xlsx') || lower.endsWith('.csv')) return 'sheet';
    if (lower.endsWith('.doc') || lower.endsWith('.docx') || lower.endsWith('.md') || lower.endsWith('.txt')) return 'doc';
    return 'generic';
  }

  function getPhaseMeta() {
    switch (state.phase) {
      case 'injecting':
        return { text: '注入中', chip: 'amber' };
      case 'awaiting_send':
        return { text: '待发送', chip: 'purple' };
      case 'sending':
        return { text: '发送中', chip: 'teal' };
      case 'cooldown':
        return { text: '冷却中', chip: 'sand' };
      case 'paused':
        return { text: '已暂停', chip: 'gray' };
      case 'error':
        return { text: '需重试', chip: 'red' };
      case 'done':
        return { text: '已完成', chip: 'green' };
      default:
        return { text: '待开始', chip: 'gray' };
    }
  }

  function getNoticeMarkup() {
    const notices = [];

    if (state.errorMessage) {
      notices.push(`<div class="dfs-notice ${state.phase === 'error' ? 'error' : 'warning'}">${escapeHtml(state.errorMessage)}</div>`);
    }
    if (
      state.phase === 'error' &&
      hasCurrentBatch() &&
      typeof shared.hasDuplicateBatchFileNames === 'function' &&
      shared.hasDuplicateBatchFileNames()
    ) {
      notices.push('<div class="dfs-notice muted">当前批次含同名文件，暂不支持“仅重试失败项”。为避免误判，请先使用“重试本批”。</div>');
    }
    if (!notices.length && !hasCurrentBatch() && state.queue.length) {
      const composerAttachmentCount = getKnownComposerAttachmentCount();
      const injectableBatchSize = getInjectableBatchSize(composerAttachmentCount);
      if (composerAttachmentCount >= MAX_FILES_PER_BATCH) {
        notices.push(`<div class="dfs-notice warning">当前输入框已有 ${composerAttachmentCount} 个附件，已达到 ${MAX_FILES_PER_BATCH} 个附件上限。请先发送或清空后，再继续注入待处理队列。</div>`);
      }
      if (!notices.length && composerAttachmentCount > 0 && injectableBatchSize > 0 && injectableBatchSize < Math.min(getEffectiveBatchSize(), state.queue.length)) {
        notices.push(`<div class="dfs-notice muted">当前输入框已有 ${composerAttachmentCount} 个附件。本轮首批会自动缩到 ${injectableBatchSize} 个文件，避免超过 ${MAX_FILES_PER_BATCH} 个附件上限。</div>`);
      }
    }
    if (!notices.length && state.phase === 'awaiting_send') {
      notices.push('<div class="dfs-notice warning">当前批次已进入输入框。插件会优先尝试发送；如果页面没有识别到发送动作，可以点击“继续”标记为已发送。</div>');
    }
    if (!notices.length && state.phase === 'paused' && hasCurrentBatch()) {
      notices.push('<div class="dfs-notice muted">自动推进已暂停。当前批次仍保留在输入区，处理完成后点击“继续”即可。</div>');
    }
    return notices.join('');
  }

  function renderFileChip(item, options = {}) {
    const kind = getFileKind(item.name);
    const remove = options.removable
      ? `<span class="remove-btn" data-queue-index="${options.index}" title="移除">✕</span>`
      : '';
    return `<span class="dfs-file-chip"><span class="dfs-file-icon ${kind}"></span><span class="dfs-file-name">${escapeHtml(item.name)}</span>${remove}</span>`;
  }

  const shared = window.__dfsShared || (window.__dfsShared = {});

  Object.assign(shared, {
    MAX_FILES_PER_BATCH,
    MAX_SIZE,
    STORAGE_KEY,
    MIN_BATCH_INTERVAL_SECONDS,
    MAX_BATCH_INTERVAL_SECONDS,
    DEFAULT_BATCH_INTERVAL_SECONDS,
    ATTACHMENT_TIMEOUT_MIN_MS,
    ATTACHMENT_TIMEOUT_MAX_MS,
    ATTACHMENT_POLL_MS,
    SETTLEMENT_POLL_MS,
    SETTLEMENT_MAX_POLLS,
    COMPOSER_READY_POLL_MS,
    COMPOSER_READY_TIMEOUT_MS,
    COMPOSER_READY_STABLE_POLLS,
    COMPOSER_RECOVERY_COOLDOWN_MS,
    AUTO_SEND_READY_TIMEOUT_MS,
    AUTO_SEND_POLL_MS,
    AUTO_CONTEXT_MARKER,
    KEYWORD_GROUPS,
    SEND_KEYWORD_RE,
    STOP_KEYWORD_RE,
    EXPLICIT_STOP_KEYWORD_RE,
    UPLOAD_KEYWORD_RE,
    SEARCH_EXCLUSION_KEYWORD_RE,
    ATTACHMENT_NAME_RE,
    ATTACHMENT_SIZE_RE,
    ATTACHMENT_ERROR_RE,
    ATTACHMENT_SERVER_BUSY_RE,
    ATTACHMENT_SELECTORS,
    state,
    ui,
    domCache,
    normalizeExtension,
    normalizeBatchIntervalSeconds,
    getConfiguredBatchSize,
    getEffectiveBatchSize,
    getKnownComposerAttachmentCount,
    getAvailableAttachmentSlots,
    getInjectableBatchSize,
    getProjectedBatchCount,
    setRenderSnapshot,
    invalidateDomCache,
    scheduleDomCacheInvalidation,
    getCachedDomValue,
    getCachedAttachmentElements,
    hasCurrentBatch,
    isBatchVisible,
    isBusyPhase,
    hasPendingWork,
    getPendingCount,
    queueStartsWithCurrentBatch,
    getQueuedItemsAfterCurrentBatch,
    getQueuedCountAfterCurrentBatch,
    getCurrentBatchNumber,
    getProgressPercent,
    clearSettlementTimer,
    clearAdvanceTimer,
    clearSuccessTimer,
    clearAllTimers,
    resetBatchAttachmentStatus,
    restoreCurrentBatchToQueue,
    bumpRunToken,
    refreshTotalBatches,
    rememberHistory,
    saveState,
    loadState,
    classifyFiles,
    escapeHtml,
    getPhaseMeta,
    getNoticeMarkup,
    renderFileChip
  });

  window.__dfsState = state;
  window.__dfsDebug = () => {
    console.log('phase:', state.phase);
    console.log('queue:', state.queue.length);
    console.log('currentBatch:', state.currentBatch.length);
    console.log('completed:', state.completedBatches, '/', state.totalBatches);
    console.log('mode:', state.uploadMode, 'source:', state.uploadSource);
  };
})();
