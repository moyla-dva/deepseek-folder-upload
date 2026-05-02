(function () {
  'use strict';

  const shared = window.__dfsShared;
  if (!shared) return;

  const {
    MAX_FILES_PER_BATCH,
    MIN_BATCH_INTERVAL_SECONDS,
    MAX_BATCH_INTERVAL_SECONDS,
    state,
    ui,
    normalizeExtension,
    getEffectiveBatchSize,
    hasCurrentBatch,
    hasPendingWork,
    getPendingCount,
    queueStartsWithCurrentBatch,
    getQueuedItemsAfterCurrentBatch,
    getCurrentBatchNumber,
    getProgressPercent,
    getKnownComposerAttachmentCount,
    isFolderReviewPhase,
    getRemainingFolderReviewMs,
    setRenderSnapshot,
    refreshTotalBatches,
    saveState,
    escapeHtml,
    getPhaseMeta,
    getNoticeMarkup,
    renderFileChip,
    isBusyPhase
  } = shared;

  const CURRENT_BATCH_PREVIEW_LIMIT = 6;
  const QUEUE_PREVIEW_LIMIT = 6;
  const SESSION_LOG_PREVIEW_LIMIT = 4;

  function getComposerAttachmentCount() {
    if (typeof getKnownComposerAttachmentCount === 'function') {
      return getKnownComposerAttachmentCount();
    }
    return typeof shared.getComposerAttachmentCount === 'function'
      ? shared.getComposerAttachmentCount()
      : 0;
  }

  function syncUIPlacement() {
    if (typeof shared.syncUIPlacement === 'function') {
      shared.syncUIPlacement();
    }
  }

  function isReviewingFolderSelection() {
    if (typeof isFolderReviewPhase === 'function') {
      return isFolderReviewPhase();
    }
    return state.phase === 'reviewing' && !hasCurrentBatch();
  }

  function formatReviewCountdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${seconds} 秒`;
  }

  function isFullReviewMode() {
    return isReviewingFolderSelection() && state.reviewMode === 'full';
  }

  function getReviewQuery() {
    return String(state.reviewQuery || '').trim().toLowerCase();
  }

  function getReviewEntries() {
    const query = getReviewQuery();
    return state.queue
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (!query) return true;
        const haystack = `${String(item.path || item.name || '').toLowerCase()}\n${String(item.name || '').toLowerCase()}`;
        return haystack.includes(query);
      });
  }

  function renderFullReviewSection(entries) {
    const query = state.reviewQuery || '';
    const filteredCount = entries.length;
    const deletedCount = Math.max(0, state.removedDuringReviewCount || 0);
    const rows = filteredCount
      ? entries.map(({ item, index }) => {
        const displayPath = String(item.path || item.name || '');
        const showPath = displayPath && displayPath !== item.name;
        return `
          <div class="dfs-review-item">
            <div class="dfs-review-main">
              <div class="dfs-review-name">${escapeHtml(item.name)}</div>
              ${showPath ? `<div class="dfs-review-path">${escapeHtml(displayPath)}</div>` : ''}
            </div>
            <button type="button" class="dfs-btn ghost" data-queue-index="${index}">删除</button>
          </div>
        `;
      }).join('')
      : '<div class="dfs-review-empty">没有匹配到文件。你可以修改搜索词，或返回预览后直接开始上传。</div>';

    return `
      <section class="dfs-panel-card tone-queue">
        <div class="dfs-section-head">
          <div>
            <div class="dfs-section-kicker">Review All</div>
            <div class="dfs-section-label">完整检查</div>
          </div>
          <div class="dfs-panel-meta">${filteredCount} / ${state.queue.length} 个文件${deletedCount ? ` · 已删除 ${deletedCount}` : ''}</div>
        </div>
        <div class="dfs-review-toolbar">
          <input type="search" id="dfs-review-search" class="dfs-review-search" value="${escapeHtml(query)}" placeholder="搜索文件名或相对路径">
          <button type="button" class="dfs-btn ghost" id="dfs-review-back-btn">返回预览</button>
          ${query ? '<button type="button" class="dfs-btn ghost" id="dfs-review-clear-search-btn">清空搜索</button>' : ''}
        </div>
        <div class="dfs-setting-help">这里会显示完整待上传列表。删除操作只会影响本轮尚未开始上传的文件。</div>
        <div class="dfs-review-list">${rows}</div>
      </section>
    `;
  }

  function updateHeaderChips() {
    const sourceChip = document.getElementById('dfs-source-chip');
    const modeChip = document.getElementById('dfs-mode-chip');

    if (sourceChip) {
      sourceChip.textContent = state.uploadSource === 'folder' ? '文件夹导入' : '文件导入';
      sourceChip.className = `dfs-chip sand`;
    }

    if (modeChip) {
      modeChip.textContent = state.uploadMode === 'auto' ? '自动发送' : '仅注入';
      modeChip.className = `dfs-chip ${state.uploadMode === 'auto' ? 'teal' : 'slate'}`;
    }
  }

  function updateTabLabels() {
    const skippedTab = document.getElementById('dfs-tab-skipped');
    if (skippedTab) skippedTab.textContent = state.skipped.length ? `已跳过 ${state.skipped.length}` : '已跳过';
  }

  function getSessionLogStatusMeta(status) {
    switch (status) {
      case 'injecting':
        return { text: '注入中', chip: 'amber' };
      case 'awaiting_send':
        return { text: '待发送', chip: 'slate' };
      case 'sending':
        return { text: '发送中', chip: 'teal' };
      case 'sent':
        return { text: '已发送', chip: 'green' };
      case 'assumed_sent':
        return { text: '人工确认', chip: 'sand' };
      case 'failed':
        return { text: '失败', chip: 'red' };
      case 'paused':
        return { text: '已暂停', chip: 'gray' };
      default:
        return { text: '处理中', chip: 'gray' };
    }
  }

  function formatLogTime(isoText) {
    if (!isoText) return '';
    const date = new Date(isoText);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function getSessionLogTimeline(entry) {
    const segments = [];
    const startedAt = formatLogTime(entry.startedAt);
    const sentAt = formatLogTime(entry.sentAt);
    const settledAt = formatLogTime(entry.settledAt);

    if (startedAt) segments.push(`开始 ${startedAt}`);
    if (sentAt) segments.push(`发送 ${sentAt}`);
    if (settledAt) segments.push(`完成 ${settledAt}`);

    return segments.join(' · ');
  }

  function renderSessionLogSection() {
    if (!state.sessionLog.length) return '';

    const logItems = state.sessionLog.slice(0, 6).map(entry => {
      const meta = getSessionLogStatusMeta(entry.status);
      const filePreview = (entry.fileNames || []).slice(0, SESSION_LOG_PREVIEW_LIMIT);
      const extraCount = Math.max(0, (entry.fileCount || 0) - filePreview.length);
      const details = [
        `第 ${entry.batchNumber || '-'} 批`,
        `${entry.fileCount || 0} 个文件`
      ];
      const timeline = getSessionLogTimeline(entry);
      if (timeline) details.push(timeline);
      if (entry.errorType) details.push(`类型 ${escapeHtml(entry.errorType)}`);

      return `
        <article class="dfs-log-item">
          <div class="dfs-log-top">
            <div class="dfs-log-title">${details.join(' · ')}</div>
            <span class="dfs-chip ${meta.chip}">${meta.text}</span>
          </div>
          ${entry.notes ? `<div class="dfs-log-note">${escapeHtml(entry.notes)}</div>` : ''}
          <div class="dfs-file-grid is-compact">
            ${filePreview.map(name => renderFileChip({ name })).join('')}
            ${extraCount ? `<span class="dfs-file-chip dfs-file-chip-more">+${extraCount} 个…</span>` : ''}
          </div>
        </article>
      `;
    }).join('');

    return `
      <section class="dfs-panel-card tone-log">
        <div class="dfs-section-head">
          <div>
            <div class="dfs-section-kicker">Session Log</div>
            <div class="dfs-section-label">本次会话记录</div>
          </div>
          <div class="dfs-panel-meta">最近 ${Math.min(state.sessionLog.length, 6)} 批</div>
        </div>
        <div class="dfs-log-list">${logItems}</div>
      </section>
    `;
  }

  function renderQueueTab() {
    const body = document.getElementById('dfs-drawer-body');
    if (!body) return;

    if (!hasPendingWork() && state.phase === 'done') {
      body.innerHTML = [
        `
        <section class="dfs-hero-card is-success">
          <div class="dfs-card-kicker">Session Complete</div>
          <h3 class="dfs-empty-title">全部批次已经处理完成</h3>
          <p class="dfs-empty-copy">当前对话的资料已全部送入流程。你可以直接查看结果，或关闭工作台开始新的上传。</p>
        </section>
      `,
        renderSessionLogSection()
      ].filter(Boolean).join('');
      return;
    }

    if (!hasPendingWork() && state.phase !== 'done') {
      body.innerHTML = `
        <section class="dfs-hero-card">
          <div class="dfs-card-kicker">Ready</div>
          <h3 class="dfs-empty-title">先设定节奏，再选择资料</h3>
          <p class="dfs-empty-copy">你可以先切到“设置”决定是自动发送还是仅注入，然后从下面选择文件夹或单独文件开始本轮任务。</p>
          <div class="dfs-empty-actions">
            <button type="button" class="dfs-btn primary" id="dfs-pick-folder-btn">选择文件夹</button>
            <button type="button" class="dfs-btn ghost" id="dfs-pick-files-btn">选择文件</button>
          </div>
        </section>
      `;
      return;
    }

    const currentIndex = Math.max(getCurrentBatchNumber(), 1);
    const totalBatches = Math.max(state.totalBatches, 1);
    const pendingFiles = getPendingCount();
    const phaseMeta = getPhaseMeta();
    const queuedItems = getQueuedItemsAfterCurrentBatch();
    const reviewingFolderSelection = isReviewingFolderSelection();
    const fullReviewMode = isFullReviewMode();
    const remainingReviewMs = typeof getRemainingFolderReviewMs === 'function'
      ? getRemainingFolderReviewMs()
      : 0;
    const htmlParts = [
      `
        <section class="dfs-progress-card">
          <div class="dfs-progress-top">
            <div>
              <div class="dfs-card-kicker">Batch Flow</div>
              <div class="dfs-progress-count">第 ${currentIndex} / ${totalBatches} 批</div>
            </div>
            <span class="dfs-chip ${phaseMeta.chip}">${phaseMeta.text}</span>
          </div>
          <div class="dfs-progress-caption">保持同一轮对话上下文，按批自动推进；需要你确认时会停在这里。</div>
          <div class="dfs-progress-bar">
            <div class="dfs-progress-fill" style="width:${getProgressPercent()}%"></div>
          </div>
          <div class="dfs-metric-strip">
            <span class="dfs-metric-pill"><strong>${pendingFiles}</strong> 剩余文件</span>
            <span class="dfs-metric-pill"><strong>${state.completedBatches}</strong> 已完成批次</span>
            <span class="dfs-metric-pill"><strong>${queuedItems.length}</strong> 待注入队列</span>
          </div>
        </section>
      `,
      getNoticeMarkup()
    ];

    if (reviewingFolderSelection && !fullReviewMode) {
      const reviewAutoStartCopy = remainingReviewMs > 0
        ? `文件夹已导入完成，${formatReviewCountdown(remainingReviewMs)}后会自动开始上传。若有少数不需要的文件，可先删除再继续。`
        : '文件夹已导入完成。自动开始已暂停，你可以先删除少数不需要的文件，再手动开始上传。';
      htmlParts.push(`
        <section class="dfs-panel-card tone-queue">
          <div class="dfs-section-head">
            <div>
              <div class="dfs-section-kicker">Review</div>
              <div class="dfs-section-label">导入后检查</div>
            </div>
            <div class="dfs-panel-meta">${pendingFiles} 个文件待确认</div>
          </div>
          <div class="dfs-setting-help">${reviewAutoStartCopy}</div>
          <div class="dfs-empty-actions">
            <button type="button" class="dfs-btn primary" id="dfs-review-start-btn">立即开始上传</button>
            <button type="button" class="dfs-btn ghost" id="dfs-review-inspect-btn">继续检查</button>
          </div>
        </section>
      `);
    }

    if (fullReviewMode) {
      htmlParts.push(renderFullReviewSection(getReviewEntries()));
    }

    if (hasCurrentBatch()) {
      const attachmentSummary = state.currentBatchExpectedAttachments
        ? `${state.currentBatchDetectedAttachments || 0} / ${state.currentBatchExpectedAttachments} 附件确认`
        : `${state.currentBatch.length} 个文件`;
      const currentBatchPreview = state.currentBatch.slice(0, CURRENT_BATCH_PREVIEW_LIMIT);
      const currentBatchOverflow = Math.max(0, state.currentBatch.length - currentBatchPreview.length);

      htmlParts.push(`
        <section class="dfs-panel-card tone-current">
          <div class="dfs-section-head">
            <div>
              <div class="dfs-section-kicker">Current Batch</div>
              <div class="dfs-section-label">当前批次</div>
            </div>
            <div class="dfs-panel-meta">${attachmentSummary}</div>
          </div>
          <div class="dfs-file-grid">
            ${currentBatchPreview.map(item => renderFileChip(item)).join('')}
            ${currentBatchOverflow ? `<span class="dfs-file-chip dfs-file-chip-more">+${currentBatchOverflow} 个…</span>` : ''}
          </div>
        </section>
      `);
    }

    if (queuedItems.length && !fullReviewMode) {
      const queueOffset = queueStartsWithCurrentBatch() ? state.currentBatch.length : 0;
      const preview = queuedItems.slice(0, Math.min(queuedItems.length, QUEUE_PREVIEW_LIMIT));
      htmlParts.push(`
        <section class="dfs-panel-card tone-queue">
          <div class="dfs-section-head">
            <div>
              <div class="dfs-section-kicker">Next In Line</div>
              <div class="dfs-section-label">待处理队列</div>
            </div>
            <div class="dfs-panel-meta">${queuedItems.length} 个文件待注入</div>
          </div>
          <div class="dfs-file-grid">
            ${preview.map((item, index) => renderFileChip(item, { removable: true, index: queueOffset + index })).join('')}
            ${queuedItems.length > preview.length ? `<span class="dfs-file-chip dfs-file-chip-more">+${queuedItems.length - preview.length} 个…</span>` : ''}
          </div>
        </section>
      `);
    }

    const sessionLogSection = renderSessionLogSection();
    if (sessionLogSection) htmlParts.push(sessionLogSection);

    body.innerHTML = htmlParts.join('');
  }

  function renderSkippedTab() {
    const body = document.getElementById('dfs-drawer-body');
    if (!body) return;

    if (!state.skipped.length) {
      body.innerHTML = `
        <section class="dfs-hero-card is-muted">
          <div class="dfs-card-kicker">Skipped</div>
          <h3 class="dfs-empty-title">当前没有被跳过的文件</h3>
          <p class="dfs-empty-copy">大小、类型或扩展名未命中的文件会在这里集中展示，并允许你手动强制加入队列。</p>
        </section>
      `;
      return;
    }

    const grouped = state.skipped.reduce((map, item, index) => {
      const list = map.get(item.reason) || [];
      list.push({ ...item, index });
      map.set(item.reason, list);
      return map;
    }, new Map());

    let html = '';
    grouped.forEach((items, reason) => {
      html += `
        <section class="dfs-panel-card tone-skip">
          <div class="dfs-section-head">
            <div>
              <div class="dfs-section-kicker">Skipped Reason</div>
              <div class="dfs-section-label">${escapeHtml(reason)}</div>
            </div>
            <div class="dfs-panel-meta">${items.length} 个文件</div>
          </div>
      `;
      items.forEach(item => {
        html += `
          <div class="dfs-skip-item">
            <span class="dfs-skip-name">${escapeHtml(item.name)}</span>
            <button type="button" class="dfs-btn ghost" data-skip-index="${item.index}">强制加入</button>
          </div>
        `;
      });
      html += '</section>';
    });

    body.innerHTML = html;
  }

  function renderSettingsTab() {
    const body = document.getElementById('dfs-drawer-body');
    if (!body) return;

    body.innerHTML = `
      <section class="dfs-settings-card">
        <div class="dfs-section-head">
          <div>
            <div class="dfs-section-kicker">Input & Delivery</div>
            <div class="dfs-section-label">入口与发送方式</div>
          </div>
        </div>
        <div class="dfs-setting-row">
          <label for="cfg-uploadSource">来源</label>
          <select id="cfg-uploadSource">
            <option value="folder"${state.uploadSource === 'folder' ? ' selected' : ''}>文件夹</option>
            <option value="files"${state.uploadSource === 'files' ? ' selected' : ''}>文件</option>
          </select>
        </div>
        <div class="dfs-setting-row">
          <label for="cfg-uploadMode">发送方式</label>
          <select id="cfg-uploadMode">
            <option value="auto"${state.uploadMode === 'auto' ? ' selected' : ''}>自动发送</option>
            <option value="manual"${state.uploadMode === 'manual' ? ' selected' : ''}>仅注入</option>
          </select>
        </div>
      </section>

      <section class="dfs-settings-card">
        <div class="dfs-section-head">
          <div>
            <div class="dfs-section-kicker">Pacing</div>
            <div class="dfs-section-label">批次节奏</div>
          </div>
        </div>
        <div class="dfs-setting-row">
          <label for="cfg-batchSize">每批数量</label>
          <input type="number" id="cfg-batchSize" min="1" max="${MAX_FILES_PER_BATCH}" step="1" value="${state.config.batchSize}">
        </div>
        <div class="dfs-setting-help">当前会话有效批大小：${getEffectiveBatchSize()}。若连续命中“服务器繁忙” 2 次，会临时减半；连续成功 2 批后会逐步恢复。</div>
        <div class="dfs-setting-row">
          <label for="cfg-sendDelay">发送延迟（秒）</label>
          <input type="number" id="cfg-sendDelay" min="0" max="10" step="0.1" value="${state.config.sendDelay}">
        </div>
        <div class="dfs-setting-column">
          <label for="cfg-batchInterval">基础批次冷却</label>
          <input type="range" id="cfg-batchInterval" min="${MIN_BATCH_INTERVAL_SECONDS}" max="${MAX_BATCH_INTERVAL_SECONDS}" step="1" value="${state.config.batchInterval}">
          <div class="dfs-setting-help" id="cfg-batchInterval-help">当前基础冷却 ${state.config.batchInterval} 秒。实际等待 = 基础冷却 + 每个已发送文件额外 0.1 秒；若上一批 50 个文件，则本轮大约等待 ${state.config.batchInterval + 5} 秒。</div>
        </div>
      </section>

      <section class="dfs-settings-card">
        <div class="dfs-section-head">
          <div>
            <div class="dfs-section-kicker">Context</div>
            <div class="dfs-section-label">上下文与文件规则</div>
          </div>
        </div>
        <div class="dfs-setting-column">
          <label for="cfg-messageTemplate">全局前缀 Prompt</label>
          <textarea id="cfg-messageTemplate">${escapeHtml(state.config.messageTemplate)}</textarea>
          <div class="dfs-setting-help">每一批发送时都会自动带上这段前缀，适合描述总任务目标和回复边界。</div>
        </div>
        <div class="dfs-setting-column">
          <label for="cfg-extensions">自定义扩展名</label>
          <input type="text" id="cfg-extensions" value="${escapeHtml(state.config.customExtensions.join(','))}">
          <div class="dfs-setting-help">例如：.ps1,.sh,.ipynb</div>
        </div>
      </section>
    `;

    const bindChange = (id, handler) => {
      const element = document.getElementById(id);
      if (!element) return;
      element.addEventListener('change', () => {
        handler(element);
        refreshTotalBatches();
        updateAll();
        saveState();
      });
    };

    bindChange('cfg-uploadSource', el => {
      state.uploadSource = el.value === 'files' ? 'files' : 'folder';
    });
    bindChange('cfg-uploadMode', el => {
      state.uploadMode = el.value === 'manual' ? 'manual' : 'auto';
    });
    bindChange('cfg-batchSize', el => {
      state.config.batchSize = Math.min(MAX_FILES_PER_BATCH, Math.max(1, parseInt(el.value, 10) || MAX_FILES_PER_BATCH));
    });
    bindChange('cfg-sendDelay', el => {
      state.config.sendDelay = Math.max(0, parseFloat(el.value) || 0);
    });
    const batchIntervalInput = document.getElementById('cfg-batchInterval');
    const batchIntervalHelp = document.getElementById('cfg-batchInterval-help');
    if (batchIntervalInput && batchIntervalHelp) {
      const renderBatchIntervalHelp = () => {
        const seconds = Math.max(MIN_BATCH_INTERVAL_SECONDS, parseInt(batchIntervalInput.value, 10) || MIN_BATCH_INTERVAL_SECONDS);
        batchIntervalHelp.textContent = `当前基础冷却 ${seconds} 秒。实际等待 = 基础冷却 + 每个已发送文件额外 0.1 秒；若上一批 50 个文件，则本轮大约等待 ${seconds + 5} 秒。`;
      };
      batchIntervalInput.addEventListener('input', renderBatchIntervalHelp);
      renderBatchIntervalHelp();
    }
    bindChange('cfg-batchInterval', el => {
      state.config.batchInterval = Math.min(MAX_BATCH_INTERVAL_SECONDS, Math.max(MIN_BATCH_INTERVAL_SECONDS, parseInt(el.value, 10) || MIN_BATCH_INTERVAL_SECONDS));
    });
    bindChange('cfg-messageTemplate', el => {
      state.config.messageTemplate = el.value;
    });
    bindChange('cfg-extensions', el => {
      state.config.customExtensions = el.value.split(',').map(normalizeExtension).filter(Boolean);
    });
  }

  function renderActiveTab() {
    if (ui.activeTab === 'skipped') renderSkippedTab();
    else if (ui.activeTab === 'settings') renderSettingsTab();
    else renderQueueTab();
  }

  function setActiveTab(tabName) {
    ui.activeTab = ['queue', 'skipped', 'settings'].includes(tabName) ? tabName : 'queue';
    document.querySelectorAll('.dfs-drawer-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === ui.activeTab);
    });
    renderActiveTab();
  }

  function updateFooterButtons() {
    const pauseBtn = document.getElementById('dfs-pause-btn');
    const retryFailedBtn = document.getElementById('dfs-retry-failed-btn');
    const retryBtn = document.getElementById('dfs-retry-btn');
    const continueBtn = document.getElementById('dfs-continue-btn');
    const canAssumeSent = !(
      hasCurrentBatch() &&
      ['awaiting_send', 'paused', 'error'].includes(state.phase) &&
      !state.currentBatchAttachmentsConfirmed &&
      getComposerAttachmentCount() > state.composerBaselineAttachments
    );

    if (pauseBtn) {
      pauseBtn.textContent = state.isPaused ? '恢复流程' : '暂停';
      pauseBtn.disabled = isReviewingFolderSelection() || (!hasPendingWork() && state.phase !== 'paused');
    }

    const canRetryFailedOnly = hasCurrentBatch() &&
      state.phase === 'error' &&
      Boolean(state.lastFailureContext?.canRetryFailedOnly);

    if (retryFailedBtn) {
      retryFailedBtn.hidden = !canRetryFailedOnly;
      retryFailedBtn.disabled = !canRetryFailedOnly;
      retryFailedBtn.classList.toggle('spacer', canRetryFailedOnly);
    }

    if (retryBtn) {
      const canRetry = hasCurrentBatch() && ['awaiting_send', 'paused', 'error'].includes(state.phase);
      retryBtn.hidden = !canRetry;
      retryBtn.disabled = !canRetry;
      retryBtn.classList.toggle('spacer', !canRetryFailedOnly && canRetry);
    }

    if (continueBtn) {
      if (isReviewingFolderSelection() && state.queue.length) {
        continueBtn.textContent = '开始上传';
      } else if (hasCurrentBatch() && ['awaiting_send', 'paused', 'error'].includes(state.phase)) {
        continueBtn.textContent = canAssumeSent ? '标记已发' : '先检查附件';
      } else if (state.queue.length) {
        continueBtn.textContent = '继续下一批';
      } else if (!hasPendingWork() && state.phase !== 'done') {
        continueBtn.textContent = '关闭';
      } else {
        continueBtn.textContent = '完成';
      }
      continueBtn.disabled = isBusyPhase() || state.phase === 'cooldown' || !canAssumeSent;
    }
  }

  function updateButtonState() {
    if (!ui.btn) return;
    const ringState = state.phase === 'injecting'
      ? 'injecting'
      : state.phase === 'awaiting_send' && hasCurrentBatch()
        ? 'awaiting'
        : state.phase === 'sending'
          ? 'sending'
          : state.phase === 'paused'
            ? 'paused'
            : '';

    ui.btn.classList.toggle('is-injecting', ringState === 'injecting');
    ui.btn.classList.toggle('is-awaiting', ringState === 'awaiting');
    ui.btn.classList.toggle('is-sending', ringState === 'sending');
    ui.btn.classList.toggle('is-paused', state.phase === 'paused');
    ui.btn.classList.toggle('is-error', state.phase === 'error');
    ui.btn.classList.toggle('is-done', state.phase === 'done');
    ui.btn.title = state.phase && state.phase !== 'idle'
      ? `批量上传工作台（${getPhaseMeta().text}）`
      : '批量上传工作台';

    let badge = ui.btn.querySelector('.dfs-badge');
    let badgeText = '';

    if (state.phase === 'error') {
      badgeText = '!';
    } else if (isBusyPhase() || hasCurrentBatch()) {
      badgeText = state.totalBatches ? `${getCurrentBatchNumber()}/${state.totalBatches}` : '';
    } else if (getPendingCount() > 0) {
      badgeText = getPendingCount() > 99 ? '99+' : String(getPendingCount());
    }

    if (badgeText) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'dfs-badge';
        ui.btn.appendChild(badge);
      }
      badge.textContent = badgeText;
    } else if (badge) {
      badge.remove();
    }

    let ring = ui.btn.querySelector('.dfs-progress-ring');
    if (ringState) {
      if (!ring) {
        ring = document.createElement('div');
        ring.className = 'dfs-progress-ring';
        ui.btn.appendChild(ring);
      }
      ring.className = `dfs-progress-ring ${ringState}`;
    } else if (ring) {
      ring.remove();
    }
  }

  function updateAll() {
    const composerAttachmentCount = getComposerAttachmentCount();
    setRenderSnapshot?.({ composerAttachmentCount });
    try {
      refreshTotalBatches();
      updateHeaderChips();
      updateTabLabels();
      updateButtonState();
      updateFooterButtons();
      renderActiveTab();
    } finally {
      setRenderSnapshot?.(null);
    }
  }

  function showDrawer(tabName = ui.activeTab || 'queue') {
    if (!ui.drawer) return;
    syncUIPlacement();
    clearTimeout(ui.drawerHideTimerId);
    ui.wrapper?.classList.add('drawer-open');
    ui.drawer.style.display = 'flex';
    requestAnimationFrame(() => ui.drawer.classList.add('is-open'));
    setActiveTab(tabName);
    updateHeaderChips();
    updateFooterButtons();
  }

  function hideDrawer() {
    if (!ui.drawer) return;
    ui.wrapper?.classList.remove('drawer-open');
    ui.drawer.classList.remove('is-open');
    clearTimeout(ui.drawerHideTimerId);
    ui.drawerHideTimerId = setTimeout(() => {
      if (!ui.drawer.classList.contains('is-open')) {
        ui.drawer.style.display = 'none';
      }
    }, 180);
  }

  Object.assign(shared, {
    updateHeaderChips,
    updateTabLabels,
    renderQueueTab,
    renderSkippedTab,
    renderSettingsTab,
    renderActiveTab,
    setActiveTab,
    updateFooterButtons,
    updateButtonState,
    updateAll,
    showDrawer,
    hideDrawer
  });
})();
