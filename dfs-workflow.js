(function () {
  'use strict';

  const shared = window.__dfsShared;
  if (!shared) return;

  const {
    MAX_FILES_PER_BATCH,
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
    state,
    ui,
    hasCurrentBatch,
    isBusyPhase,
    hasPendingWork,
    getConfiguredBatchSize,
    getEffectiveBatchSize,
    queueStartsWithCurrentBatch,
    getQueuedCountAfterCurrentBatch,
    getCurrentBatchNumber,
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
    classifyFiles,
    updateHeaderChips,
    updateAll,
    showDrawer,
    hideDrawer,
    findUploadInput,
    findComposerTextarea,
    getComposerForm,
    isElementVisible,
    findSendButton,
    isSendButtonAvailable,
    isControlDisabled,
    isAssistantResponding,
    observeComposerSignals,
    getComposerAttachmentCount,
    inspectBatchAttachmentState,
    hasAttachmentErrorIndicators
  } = shared;

  const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];
  const SERVER_BUSY_RETRY_DELAYS_MS = [3000, 6000, 12000];
  const BATCH_COOLDOWN_PER_FILE_MS = 100;
  const MIN_ADAPTIVE_BATCH_SIZE = 5;
  const SERVER_BUSY_SHRINK_THRESHOLD = 2;
  const SUCCESSFUL_BATCHES_TO_RESTORE = 2;

  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function requestUserConfirmation(message, options) {
    if (typeof shared.requestConfirmation === 'function') {
      return shared.requestConfirmation(message, options);
    }
    return Promise.resolve(window.confirm(message));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getBaseBatchCooldownMs() {
    const seconds = Number.isFinite(Number(state.config.batchInterval))
      ? Number(state.config.batchInterval)
      : DEFAULT_BATCH_INTERVAL_SECONDS;
    return Math.min(30, Math.max(3, seconds)) * 1000;
  }

  function getBatchCooldownMs(fileCount = state.lastSettledBatchSize) {
    return getBaseBatchCooldownMs() + (Math.max(0, fileCount) * BATCH_COOLDOWN_PER_FILE_MS);
  }

  function getRemainingBatchCooldownMs() {
    return Math.max(0, (state.nextBatchReadyAt || 0) - Date.now());
  }

  function formatDurationMs(ms) {
    const seconds = Math.max(0, ms) / 1000;
    return seconds >= 10 ? `${Math.round(seconds)} 秒` : `${seconds.toFixed(1)} 秒`;
  }

  function describeBatchCooldown(fileCount = state.lastSettledBatchSize, remainingMs = getRemainingBatchCooldownMs()) {
    const safeFileCount = Math.max(0, fileCount || 0);
    const totalExtraSeconds = ((safeFileCount * BATCH_COOLDOWN_PER_FILE_MS) / 1000).toFixed(1);
    return `上一批共发送 ${safeFileCount} 个文件。为降低“服务器繁忙”概率，正在冷却 ${formatDurationMs(remainingMs)} 后继续下一批（基础 ${Math.round(getBaseBatchCooldownMs() / 1000)} 秒 + 每文件 0.1 秒附加等待，本轮附加 ${totalExtraSeconds} 秒）。`;
  }

  function getAttachmentRetryDelayMs(result, index) {
    const delays = result?.serverBusy ? SERVER_BUSY_RETRY_DELAYS_MS : TRANSIENT_RETRY_DELAYS_MS;
    return delays[Math.min(index, delays.length - 1)] || delays[delays.length - 1];
  }

  function getAttachmentRetryMessage(result, index) {
    const attempt = index + 1;
    const total = result?.serverBusy ? SERVER_BUSY_RETRY_DELAYS_MS.length : TRANSIENT_RETRY_DELAYS_MS.length;
    if (result?.serverBusy) {
      return `检测到“服务器繁忙”，正在延长退避后重试 (${attempt}/${total})…`;
    }
    if (result?.blockedByError) {
      return `检测到附件异常状态，正在等待页面恢复后重试 (${attempt}/${total})…`;
    }
    return `附件仍在解析，正在重试确认 (${attempt}/${total})…`;
  }

  function getAdaptiveBatchFloor() {
    return Math.min(getConfiguredBatchSize(), MIN_ADAPTIVE_BATCH_SIZE);
  }

  function resetAdaptiveBatching() {
    state.sessionBatchSize = 0;
    state.consecutiveServerBusyCount = 0;
    state.consecutiveSuccessfulBatches = 0;
  }

  function clampCurrentBatchToAdaptiveSize(nextBatchSize) {
    if (!hasCurrentBatch()) {
      return { splitCurrentBatch: false, deferredCount: 0 };
    }

    if (state.currentBatch.length <= nextBatchSize) {
      state.currentBatchExpectedAttachments = state.currentBatch.length;
      state.currentBatchDetectedAttachments = Math.min(state.currentBatchDetectedAttachments, state.currentBatch.length);
      state.currentBatchAttachmentsConfirmed = false;
      return { splitCurrentBatch: false, deferredCount: 0 };
    }

    const deferredCount = state.currentBatch.length - nextBatchSize;
    state.currentBatch = state.currentBatch.slice(0, nextBatchSize);
    state.currentBatchExpectedAttachments = state.currentBatch.length;
    state.currentBatchDetectedAttachments = Math.min(state.currentBatchDetectedAttachments, state.currentBatch.length);
    state.currentBatchAttachmentsConfirmed = false;
    refreshTotalBatches();
    return {
      splitCurrentBatch: true,
      deferredCount
    };
  }

  function registerAdaptiveFailure(options = {}) {
    const serverBusy = options.serverBusy === true;
    state.consecutiveSuccessfulBatches = 0;

    if (!serverBusy) {
      state.consecutiveServerBusyCount = 0;
      return { adjusted: false, serverBusy: false };
    }

    state.consecutiveServerBusyCount += 1;
    if (state.consecutiveServerBusyCount < SERVER_BUSY_SHRINK_THRESHOLD) {
      return {
        adjusted: false,
        serverBusy: true,
        consecutiveServerBusyCount: state.consecutiveServerBusyCount
      };
    }

    state.consecutiveServerBusyCount = 0;
    const previousBatchSize = getEffectiveBatchSize();
    const nextBatchSize = Math.max(getAdaptiveBatchFloor(), Math.ceil(previousBatchSize / 2));

    if (nextBatchSize >= previousBatchSize) {
      return {
        adjusted: false,
        serverBusy: true,
        previousBatchSize,
        nextBatchSize
      };
    }

    state.sessionBatchSize = nextBatchSize;
    const splitResult = clampCurrentBatchToAdaptiveSize(nextBatchSize);
    return {
      adjusted: true,
      serverBusy: true,
      previousBatchSize,
      nextBatchSize,
      splitCurrentBatch: splitResult.splitCurrentBatch,
      deferredCount: splitResult.deferredCount
    };
  }

  function registerSuccessfulBatch() {
    state.consecutiveServerBusyCount = 0;
    state.consecutiveSuccessfulBatches += 1;

    const configuredBatchSize = getConfiguredBatchSize();
    const currentBatchSize = getEffectiveBatchSize();

    if (currentBatchSize >= configuredBatchSize) {
      state.sessionBatchSize = 0;
      state.consecutiveSuccessfulBatches = 0;
      return { restored: false, batchSize: configuredBatchSize };
    }

    if (state.consecutiveSuccessfulBatches < SUCCESSFUL_BATCHES_TO_RESTORE) {
      return { restored: false, batchSize: currentBatchSize };
    }

    const restoredBatchSize = Math.min(configuredBatchSize, currentBatchSize * 2);
    state.sessionBatchSize = restoredBatchSize >= configuredBatchSize ? 0 : restoredBatchSize;
    state.consecutiveSuccessfulBatches = 0;
    return {
      restored: restoredBatchSize > currentBatchSize,
      batchSize: restoredBatchSize
    };
  }

  function getAdaptiveBatchingMessage(adjustment) {
    if (!adjustment?.adjusted) return '';
    const currentBatchMessage = adjustment.splitCurrentBatch
      ? `当前失败批次已缩到 ${adjustment.nextBatchSize} 个文件，剩余 ${adjustment.deferredCount} 个文件会留在后续队列。`
      : `当前会话后续批次将按 ${adjustment.nextBatchSize} 个文件继续。`;
    return `连续命中“服务器繁忙”后，已将当前会话批大小从 ${adjustment.previousBatchSize} 调整为 ${adjustment.nextBatchSize}。${currentBatchMessage}`;
  }

  async function waitForComposerReadyWithBackoff(runToken) {
    let ready = await waitForComposerReady(runToken);
    if (ready || hasAttachmentErrorIndicators()) return ready;

    for (let index = 0; index < TRANSIENT_RETRY_DELAYS_MS.length; index += 1) {
      if (runToken !== state.runToken || state.isPaused || hasCurrentBatch()) return false;
      state.errorMessage = `输入区仍在恢复，正在重试 (${index + 1}/${TRANSIENT_RETRY_DELAYS_MS.length})…`;
      updateAll();
      await sleep(TRANSIENT_RETRY_DELAYS_MS[index]);
      ready = await waitForComposerReady(runToken);
      if (ready || hasAttachmentErrorIndicators()) return ready;
    }

    return false;
  }

  async function waitForAttachmentsWithBackoff(runToken, expectedFiles, batchItems = state.currentBatch) {
    let result = await waitForAttachments(runToken, expectedFiles, batchItems);
    if (result.confirmed) return result;

    for (let index = 0; index < TRANSIENT_RETRY_DELAYS_MS.length; index += 1) {
      if (runToken !== state.runToken || state.isPaused) {
        return { confirmed: false, increase: 0, failed: 0, blockedByError: false, serverBusy: false };
      }
      state.errorMessage = getAttachmentRetryMessage(result, index);
      updateAll();
      await sleep(getAttachmentRetryDelayMs(result, index));
      result = await waitForAttachments(runToken, expectedFiles, batchItems);
      if (result.confirmed) return result;
    }

    return result;
  }

  function buildBatchMessage() {
    const current = Math.max(getCurrentBatchNumber(), 1);
    const total = Math.max(state.totalBatches, current, 1);
    const remainingFiles = getQueuedCountAfterCurrentBatch();
    const remainingBatches = Math.max(total - current, 0);
    const lines = [];

    if (state.config.messageTemplate.trim()) {
      lines.push(state.config.messageTemplate.trim());
    }

    lines.push(`以下是同一任务的第 ${current} / ${total} 批附件。`);

    if (total === 1) {
      lines.push('这是本次任务的全部附件，请直接结合附件内容完成分析。');
      return lines.join('\n');
    }

    lines.push('请将本批与此前和后续批次视为同一组资料连续处理，保持同一个上下文。');

    if (remainingBatches > 0 || remainingFiles > 0) {
      lines.push(`当前还不是最后一批，后续还会继续上传 ${remainingFiles} 个文件。`);
      lines.push(`如果本批附件已接收成功，请只回复“已收到第 ${current}/${total} 批，请继续。”`);
      lines.push('除这一句外，不要输出任何其他内容，不要分析，不要总结，不要提问，不要补充说明。');
    } else {
      lines.push('这已经是最后一批，请结合全部批次内容统一分析，并给出完整、明确的结论。');
    }

    return lines.join('\n');
  }

  function mergeComposerMessage(existingValue, batchMessage) {
    const value = String(existingValue || '');
    const inlineMarker = `${AUTO_CONTEXT_MARKER}\n`;
    const trailingMarker = `\n\n${inlineMarker}`;
    let prefix = value;

    const trailingMarkerIndex = prefix.lastIndexOf(trailingMarker);
    if (trailingMarkerIndex >= 0) {
      prefix = prefix.slice(0, trailingMarkerIndex);
    } else if (prefix.startsWith(inlineMarker)) {
      prefix = '';
    }

    const cleanedPrefix = prefix.replace(/\s+$/, '');
    const autoBlock = `${AUTO_CONTEXT_MARKER}\n${batchMessage}`;
    return cleanedPrefix ? `${cleanedPrefix}\n\n${autoBlock}` : autoBlock;
  }

  function fillComposerMessage(textarea, message) {
    textarea.focus();
    setNativeValue(textarea, message);

    try {
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: message,
        inputType: 'insertText'
      }));
    } catch (error) {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function composerHasAutoContextMarker() {
    const textarea = findComposerTextarea();
    return Boolean(textarea && String(textarea.value || '').includes(AUTO_CONTEXT_MARKER));
  }

  function submitComposerForm() {
    const form = getComposerForm();
    if (!form || typeof form.requestSubmit !== 'function') return false;

    try {
      form.requestSubmit();
      return true;
    } catch (error) {
      return false;
    }
  }

  function getAttachmentWaitTimeout(expectedFiles, batchItems = state.currentBatch) {
    const items = Array.isArray(batchItems) ? batchItems : [];
    const fileCount = Math.max(expectedFiles || 0, items.length);
    const totalSizeMb = items.reduce((sum, item) => {
      const size = item?.size || item?.file?.size || 0;
      return sum + (Number.isFinite(size) ? size : 0);
    }, 0) / (1024 * 1024);
    const extraMs = Math.min(
      ATTACHMENT_TIMEOUT_MAX_MS - ATTACHMENT_TIMEOUT_MIN_MS,
      (fileCount * 1200) + (totalSizeMb * 250)
    );
    return Math.round(ATTACHMENT_TIMEOUT_MIN_MS + extraMs);
  }

  function isComposerReadyForNextBatch() {
    const textarea = findComposerTextarea();
    const uploadInput = findUploadInput();
    const sendBtn = findSendButton();
    const composerForm = getComposerForm();

    return Boolean(
      textarea &&
      isElementVisible(textarea) &&
      !textarea.disabled &&
      !textarea.readOnly &&
      uploadInput &&
      !uploadInput.disabled &&
      !isAssistantResponding() &&
      !hasAttachmentErrorIndicators() &&
      (sendBtn || composerForm)
    );
  }

  function waitForComposerReady(runToken) {
    return new Promise(resolve => {
      const deadline = Date.now() + COMPOSER_READY_TIMEOUT_MS;
      const requiredStableMs = COMPOSER_READY_STABLE_POLLS * COMPOSER_READY_POLL_MS;
      let stableSince = 0;
      let settled = false;
      let stableTimerId = null;
      let fallbackTimerId = null;
      let stopWatching = null;
      let observedBusyState = false;
      let lastBusySignalAt = 0;

      const finish = result => {
        if (settled) return;
        settled = true;
        if (stableTimerId) clearTimeout(stableTimerId);
        if (fallbackTimerId) clearInterval(fallbackTimerId);
        stopWatching?.();
        resolve(result);
      };

      const check = () => {
        if (settled) return;
        if (runToken !== state.runToken || state.isPaused || hasCurrentBatch()) {
          finish(false);
          return;
        }

        if (isAssistantResponding()) {
          observedBusyState = true;
          lastBusySignalAt = Date.now();
        }

        const coolingDown = observedBusyState &&
          lastBusySignalAt &&
          (Date.now() - lastBusySignalAt) < COMPOSER_RECOVERY_COOLDOWN_MS;

        if (isComposerReadyForNextBatch()) {
          if (!stableSince) stableSince = Date.now();
          const stableFor = Date.now() - stableSince;
          const requiredWaitMs = Math.max(
            requiredStableMs,
            coolingDown ? (lastBusySignalAt + COMPOSER_RECOVERY_COOLDOWN_MS - stableSince) : 0
          );
          if (stableFor >= requiredWaitMs) {
            finish(true);
            return;
          }
          if (!stableTimerId) {
            stableTimerId = setTimeout(() => {
              stableTimerId = null;
              check();
            }, Math.max(0, requiredWaitMs - stableFor));
          }
        } else {
          stableSince = 0;
          if (stableTimerId) {
            clearTimeout(stableTimerId);
            stableTimerId = null;
          }
        }

        if (Date.now() >= deadline) {
          finish(false);
        }
      };

      stopWatching = observeComposerSignals(check, { includeBody: true, includeTextarea: false, includeUploadInput: true });
      fallbackTimerId = setInterval(check, COMPOSER_READY_POLL_MS);
      check();
    });
  }

  function scheduleNextBatch(options = {}) {
    const force = options.force === true;
    const mode = options.mode || state.uploadMode;
    clearAdvanceTimer();
    if (!state.queue.length || state.isPaused || (!force && state.uploadMode !== 'auto')) return false;
    const delayMs = getRemainingBatchCooldownMs();
    if (delayMs > 0) {
      const refreshCooldownNotice = () => {
        const remainingMs = getRemainingBatchCooldownMs();
        if (remainingMs <= 0) {
          if (state.cooldownTickerId) {
            clearInterval(state.cooldownTickerId);
            state.cooldownTickerId = null;
          }
          return;
        }
        state.errorMessage = describeBatchCooldown(state.lastSettledBatchSize, remainingMs);
        updateAll();
      };

      state.phase = 'cooldown';
      state.errorMessage = describeBatchCooldown(state.lastSettledBatchSize, delayMs);
      updateAll();
      state.cooldownTickerId = setInterval(refreshCooldownNotice, 1000);
    }
    state.advanceTimerId = setTimeout(async () => {
      state.advanceTimerId = null;
      if (state.cooldownTickerId) {
        clearInterval(state.cooldownTickerId);
        state.cooldownTickerId = null;
      }
      if (!hasCurrentBatch() && !state.isPaused) {
        if (state.phase === 'cooldown') {
          state.phase = state.queue.length ? 'queued' : 'idle';
          state.errorMessage = '';
          updateAll();
        }
        await startNextBatch(mode);
      }
    }, delayMs);
    return true;
  }

  function resetSessionState() {
    clearAllTimers();
    state.queue = [];
    state.skipped = [];
    state.currentBatch = [];
    state.completedBatches = 0;
    state.totalBatches = 0;
    state.isPaused = false;
    state.phase = 'idle';
    state.errorMessage = '';
    state.lastSettledBatchSize = 0;
    state.nextBatchReadyAt = 0;
    state.composerBaselineAttachments = 0;
    resetAdaptiveBatching();
    resetBatchAttachmentStatus();
  }

  function finishUpload() {
    clearAllTimers();
    state.isPaused = false;
    state.phase = 'done';
    state.errorMessage = '';
    updateAll();
    showDrawer('queue');
    state.successTimerId = setTimeout(() => {
      resetSessionState();
      updateAll();
      hideDrawer();
    }, 1800);
  }

  function settleCurrentBatch(assumed = false, suppressAutoAdvance = false) {
    clearSettlementTimer();
    clearAdvanceTimer();
    if (!hasCurrentBatch()) return;
    const settledBatchSize = state.currentBatch.length;

    if (queueStartsWithCurrentBatch()) {
      state.queue = state.queue.slice(state.currentBatch.length);
    }
    state.completedBatches += 1;
    state.currentBatch = [];
    registerSuccessfulBatch();
    state.lastSettledBatchSize = settledBatchSize;
    state.nextBatchReadyAt = state.queue.length ? Date.now() + getBatchCooldownMs(settledBatchSize) : 0;
    state.isPaused = false;
    state.phase = state.queue.length ? 'queued' : 'done';
    state.errorMessage = assumed ? '' : '';
    state.composerBaselineAttachments = getComposerAttachmentCount();
    resetBatchAttachmentStatus();
    updateAll();

    if (!state.queue.length) {
      finishUpload();
      return;
    }

    if (!suppressAutoAdvance && state.uploadMode === 'auto' && !state.isPaused) scheduleNextBatch();
  }

  function enterErrorState(message, options = {}) {
    const preserveBatch = options.preserveBatch !== false;
    clearSettlementTimer();
    clearAdvanceTimer();
    state.phase = 'error';
    state.errorMessage = message;
    if (!preserveBatch) state.currentBatch = [];
    updateAll();
    showDrawer('queue');
  }

  function startSettlementWatcher(runToken, optimistic = true) {
    clearSettlementTimer();
    let polls = 0;
    let observedBusyState = false;
    const deadline = Date.now() + (optimistic ? COMPOSER_READY_TIMEOUT_MS : ((SETTLEMENT_MAX_POLLS + 2) * SETTLEMENT_POLL_MS));

    const check = () => {
      if (runToken !== state.runToken) {
        clearSettlementTimer();
        return;
      }
      if (!hasCurrentBatch()) {
        clearSettlementTimer();
        return;
      }

      const composerCount = getComposerAttachmentCount();
      const responding = isAssistantResponding();
      const sendAvailable = isSendButtonAvailable();
      const autoContextStillPresent = state.currentBatchUsedAutoContext ? composerHasAutoContextMarker() : false;

      if (optimistic && state.currentBatchAttachmentsConfirmed && isAssistantResponding()) {
        settleCurrentBatch(true);
        return;
      }

      if (optimistic && state.currentBatchAttachmentsConfirmed) {
        if (!sendAvailable) observedBusyState = true;
        if (state.currentBatchUsedAutoContext && !autoContextStillPresent) observedBusyState = true;
        if (observedBusyState && !responding && isComposerReadyForNextBatch()) {
          settleCurrentBatch(true);
          return;
        }
      }

      if (composerCount <= state.composerBaselineAttachments) {
        settleCurrentBatch(false);
        return;
      }

      if (Date.now() >= deadline || (!optimistic && polls >= SETTLEMENT_MAX_POLLS)) {
        clearSettlementTimer();
        state.phase = 'awaiting_send';
        state.errorMessage = optimistic
          ? '未能自动确认发送完成。请检查当前批次；如果已成功发出，请点击“标记已发”。'
          : '未能确认发送完成，请手动检查当前批次。';
        updateAll();
        showDrawer('queue');
        return;
      }
    };

    state.settleCleanup = observeComposerSignals(check, { includeBody: true, includeTextarea: true, includeUploadInput: false });
    state.settleTimerId = setInterval(() => {
      polls += 1;
      check();
    }, SETTLEMENT_POLL_MS);
    check();
  }

  function registerManualSendAttempt() {
    if (!hasCurrentBatch()) return;
    if (!['awaiting_send', 'paused', 'error'].includes(state.phase)) return;
    clearSuccessTimer();
    clearAdvanceTimer();
    state.phase = 'sending';
    state.errorMessage = '';
    updateAll();
    startSettlementWatcher(state.runToken, true);
  }

  function waitForAttachments(runToken, expectedFiles, batchItems = state.currentBatch) {
    return new Promise(resolve => {
      const deadline = Date.now() + getAttachmentWaitTimeout(expectedFiles, batchItems);
      const minimumIncrease = Math.max(1, expectedFiles);
      let settled = false;
      let fallbackTimerId = null;
      let stopWatching = null;

      const finish = result => {
        if (settled) return;
        settled = true;
        if (fallbackTimerId) clearInterval(fallbackTimerId);
        stopWatching?.();
        resolve(result);
      };

      const check = () => {
        if (settled) return;
        if (runToken !== state.runToken) {
          finish({ confirmed: false, increase: 0, failed: 0, blockedByError: false });
          return;
        }

        const currentCount = getComposerAttachmentCount();
        const increase = Math.max(0, currentCount - state.composerBaselineAttachments);
        const attachmentState = inspectBatchAttachmentState(batchItems);
        const matchedNames = attachmentState.matchedNames;
        const inputFileCount = attachmentState.inputFileCount;
        const detected = Math.max(increase, matchedNames, inputFileCount);

        if (attachmentState.failedAttachments > 0) {
          finish({
            confirmed: false,
            increase: detected,
            failed: attachmentState.failedAttachments,
            failedNames: attachmentState.failedNames,
            blockedByError: true,
            serverBusy: attachmentState.hasServerBusyError
          });
          return;
        }

        if (
          currentCount >= state.composerBaselineAttachments + minimumIncrease ||
          matchedNames >= expectedFiles ||
          (inputFileCount >= expectedFiles && (currentCount > state.composerBaselineAttachments || matchedNames > 0))
        ) {
          finish({ confirmed: true, increase: detected, failed: 0, blockedByError: false, serverBusy: false });
          return;
        }

        if (Date.now() >= deadline) {
          finish({ confirmed: false, increase: detected, failed: 0, blockedByError: false, serverBusy: false });
        }
      };

      stopWatching = observeComposerSignals(check, { includeBody: false, includeTextarea: false, includeUploadInput: true });
      fallbackTimerId = setInterval(check, ATTACHMENT_POLL_MS);
      check();
    });
  }

  function injectFiles(files, runToken) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;

      const tryInject = () => {
        if (runToken !== state.runToken) {
          reject(new Error('当前批次已取消。'));
          return;
        }

        const input = findUploadInput();
        if (!input) {
          if (Date.now() >= deadline) {
            reject(new Error('未找到 DeepSeek 上传输入框，请确认页面已完全加载。'));
            return;
          }
          setTimeout(tryInject, 200);
          return;
        }

        try {
          const dataTransfer = new DataTransfer();
          files.forEach(file => dataTransfer.items.add(file));
          input.files = dataTransfer.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          resolve();
        } catch (error) {
          reject(new Error('文件注入失败，请重试。'));
        }
      };

      tryInject();
    });
  }

  function attemptAutoSend(runToken) {
    return new Promise(resolve => {
      const textarea = findComposerTextarea();
      if (!textarea) {
        state.errorMessage = '未找到输入框，已切换到手动发送。';
        resolve(false);
        return;
      }

      const mergedMessage = mergeComposerMessage(textarea.value, buildBatchMessage());
      state.currentBatchUsedAutoContext = true;
      fillComposerMessage(textarea, mergedMessage);

      const deadline = Date.now() + AUTO_SEND_READY_TIMEOUT_MS;
      let settled = false;
      let fallbackTimerId = null;
      let stopWatching = null;

      const finish = result => {
        if (settled) return;
        settled = true;
        if (fallbackTimerId) clearInterval(fallbackTimerId);
        stopWatching?.();
        resolve(result);
      };

      const trySend = () => {
        if (settled) return;
        if (runToken !== state.runToken) {
          finish(false);
          return;
        }

        if (hasAttachmentErrorIndicators()) {
          state.errorMessage = '检测到当前批次存在上传失败的附件（例如“服务器繁忙”或“重试”）。请先清空失败附件，再重新发送当前批次。';
          finish(false);
          return;
        }

        const sendBtn = findSendButton();
        if (sendBtn && !isControlDisabled(sendBtn)) {
          try {
            state.phase = 'sending';
            updateAll();
            sendBtn.click();
            startSettlementWatcher(runToken, true);
            finish(true);
            return;
          } catch (error) {
            state.errorMessage = '自动点击发送失败，请手动发送当前批次。';
            finish(false);
            return;
          }
        }

        if (Date.now() < deadline) {
          return;
        }

        if (!sendBtn && submitComposerForm()) {
          state.phase = 'sending';
          updateAll();
          startSettlementWatcher(runToken, true);
          finish(true);
          return;
        }

        state.errorMessage = '发送按钮长时间不可用，附件可能仍在解析中。请稍等片刻后手动发送当前批次。';
        finish(false);
      };

      stopWatching = observeComposerSignals(trySend, { includeBody: true, includeTextarea: true, includeUploadInput: true });
      setTimeout(() => {
        if (settled || runToken !== state.runToken) return;
        fallbackTimerId = setInterval(trySend, AUTO_SEND_POLL_MS);
        trySend();
      }, Math.max(0, state.config.sendDelay) * 1000);
    });
  }

  async function retryCurrentBatch() {
    if (!hasCurrentBatch()) return;

    const runToken = bumpRunToken();
    clearAllTimers();
    state.isPaused = false;
    state.errorMessage = '';

    const composerCount = getComposerAttachmentCount();
    const attachmentsPresent = composerCount > state.composerBaselineAttachments;

    if (attachmentsPresent && !state.currentBatchAttachmentsConfirmed) {
      enterErrorState(
        `当前批次仅确认到 ${state.currentBatchDetectedAttachments || composerCount - state.composerBaselineAttachments}/${Math.max(state.currentBatchExpectedAttachments, state.currentBatch.length)} 个附件。请先手动清理输入框中的残留附件，再点击“重试本批”。`
      );
      return;
    }

    if (attachmentsPresent) {
      state.phase = 'awaiting_send';
      updateAll();
      showDrawer('queue');

      if (state.uploadMode === 'manual') {
        return;
      }

      const sent = await attemptAutoSend(runToken);
      if (runToken !== state.runToken) return;
      if (!sent) {
        state.phase = 'awaiting_send';
        updateAll();
        showDrawer('queue');
      }
      return;
    }

    state.phase = 'injecting';
    state.composerBaselineAttachments = composerCount;
    state.currentBatchExpectedAttachments = state.currentBatch.length;
    state.currentBatchDetectedAttachments = 0;
    state.currentBatchAttachmentsConfirmed = false;
    updateAll();
    showDrawer('queue');

    try {
      await injectFiles(state.currentBatch.map(item => item.file), runToken);
      if (runToken !== state.runToken) return;

      const attachmentResult = await waitForAttachmentsWithBackoff(runToken, state.currentBatch.length);
      if (runToken !== state.runToken) return;
      state.currentBatchDetectedAttachments = attachmentResult.increase;
      state.currentBatchAttachmentsConfirmed = attachmentResult.confirmed;

      if (!attachmentResult.confirmed) {
        if (attachmentResult.blockedByError) {
          const adaptiveAdjustment = registerAdaptiveFailure({ serverBusy: attachmentResult.serverBusy });
          enterErrorState(
            attachmentResult.serverBusy
              ? `检测到当前批次命中了“服务器繁忙”，并已按更长退避重试 3 轮后仍未恢复。${getAdaptiveBatchingMessage(adaptiveAdjustment)}请先清空输入框中的失败附件，稍等几秒后再点击“重试本批”。`
              : '检测到当前批次存在上传失败的附件（例如“重试上传”或网络错误）。请先清空输入框中的失败附件，稍等几秒后再点击“重试本批”。'
          );
          return;
        }
        registerAdaptiveFailure();
        enterErrorState(
          `仅确认到 ${attachmentResult.increase}/${state.currentBatch.length} 个附件。为避免丢文件，已停止自动发送。请检查输入框中的附件；如有残留请先清空，再点击“重试本批”。`
        );
        return;
      }

      state.errorMessage = '';
      state.phase = 'awaiting_send';
      updateAll();
      showDrawer('queue');

      if (state.uploadMode === 'manual') {
        return;
      }

      const sent = await attemptAutoSend(runToken);
      if (runToken !== state.runToken) return;
      if (!sent) {
        state.phase = 'awaiting_send';
        updateAll();
        showDrawer('queue');
      }
    } catch (error) {
      if (runToken !== state.runToken) return;
      registerAdaptiveFailure();
      enterErrorState(error.message || '重试失败，请手动发送或继续。');
    }
  }

  async function startNextBatch(mode = state.uploadMode) {
    if (isBusyPhase()) return;
    clearSuccessTimer();
    clearAdvanceTimer();

    if (hasCurrentBatch()) {
      const attachmentsStillVisible = getComposerAttachmentCount() > state.composerBaselineAttachments;
      if (!state.currentBatchAttachmentsConfirmed && attachmentsStillVisible) {
        enterErrorState('当前批次附件尚未确认完整。请先检查输入框中的附件；如有残留请先清空，再点击“重试本批”。');
        return;
      }
      const prompt = attachmentsStillVisible
        ? '当前批次看起来仍在输入框中。是否直接标记为已发送并继续？'
        : '将当前批次标记为已发送并继续吗？';
      const confirmed = await requestUserConfirmation(prompt, {
        title: '继续当前流程？',
        confirmText: '继续',
        cancelText: '返回检查',
        tone: attachmentsStillVisible ? 'danger' : 'primary'
      });
      if (!confirmed) {
        showDrawer('queue');
        return;
      }
      settleCurrentBatch(true, true);
      if (!state.queue.length) return;
    }

    if (!state.queue.length) {
      finishUpload();
      return;
    }

    if (getRemainingBatchCooldownMs() > 0) {
      scheduleNextBatch({ force: true, mode });
      return;
    }

    const readinessToken = state.runToken;
    const composerReady = await waitForComposerReadyWithBackoff(readinessToken);
    if (readinessToken !== state.runToken || state.isPaused || hasCurrentBatch()) return;
    if (!composerReady) {
      state.errorMessage = hasAttachmentErrorIndicators()
        ? '检测到输入框中存在上传失败的附件（例如“服务器繁忙”）。请先清空失败附件，稍等几秒后再点击“继续”。'
        : '上一轮回复尚未完全结束，或附件通道仍在恢复中，已暂停自动继续。请稍等片刻后点击“继续”。';
      updateAll();
      showDrawer('queue');
      return;
    }

    const runToken = bumpRunToken();
    clearAllTimers();
    state.lastSettledBatchSize = 0;
    state.nextBatchReadyAt = 0;
    state.currentBatch = state.queue.slice(0, Math.min(getEffectiveBatchSize(), MAX_FILES_PER_BATCH));
    state.phase = 'injecting';
    state.errorMessage = '';
    state.composerBaselineAttachments = getComposerAttachmentCount();
    state.currentBatchExpectedAttachments = state.currentBatch.length;
    state.currentBatchDetectedAttachments = 0;
    state.currentBatchAttachmentsConfirmed = false;
    updateAll();
    showDrawer('queue');

    try {
      await injectFiles(state.currentBatch.map(item => item.file), runToken);
      if (runToken !== state.runToken) return;

      const attachmentResult = await waitForAttachmentsWithBackoff(runToken, state.currentBatch.length);
      if (runToken !== state.runToken) return;
      state.currentBatchDetectedAttachments = attachmentResult.increase;
      state.currentBatchAttachmentsConfirmed = attachmentResult.confirmed;

      if (!attachmentResult.confirmed) {
        if (attachmentResult.blockedByError) {
          const adaptiveAdjustment = registerAdaptiveFailure({ serverBusy: attachmentResult.serverBusy });
          enterErrorState(
            attachmentResult.serverBusy
              ? `检测到当前批次命中了“服务器繁忙”，并已按更长退避重试 3 轮后仍未恢复。${getAdaptiveBatchingMessage(adaptiveAdjustment)}为避免继续误发，已暂停自动发送。请先清空失败附件，稍等几秒后再点击“重试本批”。`
              : '检测到当前批次存在上传失败的附件（例如“重试上传”或网络错误）。为避免继续误发，已暂停自动发送。请先清空失败附件，稍等几秒后再点击“重试本批”。'
          );
          return;
        }
        registerAdaptiveFailure();
        enterErrorState(
          `仅确认到 ${attachmentResult.increase}/${state.currentBatch.length} 个附件。为避免静默丢文件，已停止自动发送。请检查输入框中的附件；如有残留请先清空，再点击“重试本批”。`
        );
        return;
      }

      state.errorMessage = '';
      state.phase = 'awaiting_send';
      updateAll();
      showDrawer('queue');

      if (mode !== 'auto') {
        return;
      }

      const sent = await attemptAutoSend(runToken);
      if (runToken !== state.runToken) return;
      if (!sent) {
        state.phase = 'awaiting_send';
        updateAll();
        showDrawer('queue');
      }
    } catch (error) {
      if (runToken !== state.runToken) return;
      registerAdaptiveFailure();
      enterErrorState(error.message || '上传失败，请重试。', { preserveBatch: false });
    }
  }

  function togglePause() {
    clearSuccessTimer();

    if (state.isPaused) {
      state.isPaused = false;
      if (state.phase === 'paused') {
        state.phase = hasCurrentBatch() ? 'awaiting_send' : (state.queue.length ? 'queued' : 'idle');
      }
      updateAll();
      if (!hasCurrentBatch() && state.queue.length && state.uploadMode === 'auto') {
        startNextBatch(state.uploadMode);
        return;
      }
      showDrawer('queue');
      return;
    }

    state.isPaused = true;
    clearAdvanceTimer();
    clearSettlementTimer();

    if (state.phase === 'injecting') {
      bumpRunToken();
      restoreCurrentBatchToQueue();
      state.phase = state.queue.length ? 'paused' : 'idle';
    } else if (hasCurrentBatch()) {
      bumpRunToken();
      state.phase = 'paused';
    } else {
      state.phase = 'paused';
    }

    updateAll();
    showDrawer('queue');
  }

  async function clearQueue() {
    const hasComposerBatch = hasCurrentBatch() || getComposerAttachmentCount() > state.composerBaselineAttachments;
    const prompt = hasComposerBatch
      ? '确定清空内部队列吗？已注入到页面里的文件不会被自动移除。'
      : '确定清空所有待上传文件吗？';

    const confirmed = await requestUserConfirmation(prompt, {
      title: '清空上传队列？',
      confirmText: '确认清空',
      cancelText: '取消',
      tone: 'danger'
    });
    if (!confirmed) return;

    bumpRunToken();
    resetSessionState();
    updateAll();
    hideDrawer();
  }

  async function handleSelectedFiles(files, source = state.uploadSource, options = {}) {
    if (hasPendingWork() && options.allowOverwrite !== true) {
      const confirmed = await requestUserConfirmation('当前仍有未完成的批次，继续会覆盖现有队列。是否继续？', {
        title: '覆盖现有队列？',
        confirmText: '继续覆盖',
        cancelText: '保留当前队列',
        tone: 'danger'
      });
      if (!confirmed) return;
    }

    const { queue, skipped } = classifyFiles(files);

    bumpRunToken();
    resetSessionState();
    state.uploadSource = source;
    state.queue = queue;
    state.skipped = skipped;
    state.phase = queue.length ? 'queued' : 'idle';
    rememberHistory(queue.length, skipped.length);
    saveState();
    updateAll();
    showDrawer('queue');

    if (queue.length) {
      startNextBatch(state.uploadMode);
    }
  }

  function openFilePicker(sourceOverride = state.uploadSource) {
    const source = sourceOverride === 'files' ? 'files' : 'folder';
    state.uploadSource = source;
    updateHeaderChips();
    saveState();

    let input = ui.filePickerInput;
    if (!(input instanceof HTMLInputElement) || !input.isConnected) {
      input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', event => {
        const picker = event.currentTarget;
        const files = Array.from(picker.files || []);
        const selectedSource = picker.dataset.source === 'files' ? 'files' : 'folder';
        picker.value = '';
        if (!files.length) return;
        handleSelectedFiles(files, selectedSource);
      });
      document.body.appendChild(input);
      ui.filePickerInput = input;
    }

    input.dataset.source = source;
    input.value = '';

    if (source === 'folder') {
      input.webkitdirectory = true;
      input.setAttribute('webkitdirectory', '');
    } else {
      input.webkitdirectory = false;
      input.removeAttribute('webkitdirectory');
    }

    if (ui.filePickerFocusCleanupId) {
      clearTimeout(ui.filePickerFocusCleanupId);
      ui.filePickerFocusCleanupId = null;
    }

    window.addEventListener('focus', () => {
      ui.filePickerFocusCleanupId = window.setTimeout(() => {
        if (ui.filePickerInput === input) {
          input.value = '';
        }
        ui.filePickerFocusCleanupId = null;
      }, 0);
    }, { once: true });

    input.click();
  }

  async function getAllFiles(entries) {
    let files = [];
    for (const entry of entries) {
      if (entry instanceof File) {
        files.push(entry);
      } else if (entry && entry.isFile) {
        files.push(await getFile(entry));
      } else if (entry && entry.isDirectory) {
        files = files.concat(await readAllDirectoryEntries(entry.createReader()));
      }
    }
    return files;
  }

  function getFile(entry) {
    return new Promise(resolve => entry.file(resolve));
  }

  function readAllDirectoryEntries(reader) {
    return new Promise(resolve => {
      const entries = [];
      const read = () => {
        reader.readEntries(results => {
          if (results.length) {
            entries.push(...results);
            read();
          } else {
            resolve(entries);
          }
        });
      };
      read();
    }).then(async entries => {
      let files = [];
      for (const entry of entries) {
        if (entry.isFile) files.push(await getFile(entry));
        else if (entry.isDirectory) files = files.concat(await readAllDirectoryEntries(entry.createReader()));
      }
      return files;
    });
  }

  function enableDragDrop() {
    let dragDepth = 0;

    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const isIgnoredDropTarget = event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return false;
      if (target.closest('input[type="file"]')) return true;
      return false;
    };
    const clearDragState = () => {
      dragDepth = 0;
      document.body.classList.remove('dfs-drag-over');
    };

    document.addEventListener('dragenter', event => {
      if (!hasFiles(event)) return;
      if (isIgnoredDropTarget(event)) return;
      dragDepth += 1;
      document.body.classList.add('dfs-drag-over');
    });

    document.addEventListener('dragover', event => {
      if (!hasFiles(event)) return;
      if (isIgnoredDropTarget(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('dfs-drag-over');
    });

    document.addEventListener('dragleave', event => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) document.body.classList.remove('dfs-drag-over');
    });

    document.addEventListener('drop', async event => {
      if (!hasFiles(event)) return;
      if (isIgnoredDropTarget(event)) return;
      event.preventDefault();
      clearDragState();

      const items = event.dataTransfer?.items;
      if (!items) return;

      const entries = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        entries.push(item.webkitGetAsEntry ? item.webkitGetAsEntry() : item.getAsFile());
      }

      const files = await getAllFiles(entries);
      if (!files.length) return;
      handleSelectedFiles(files, 'folder');
    });

    document.addEventListener('dragend', clearDragState);
  }

  Object.assign(shared, {
    getBaseBatchCooldownMs,
    getBatchCooldownMs,
    getRemainingBatchCooldownMs,
    describeBatchCooldown,
    getAttachmentRetryDelayMs,
    resetAdaptiveBatching,
    registerAdaptiveFailure,
    registerSuccessfulBatch,
    getAdaptiveBatchingMessage,
    buildBatchMessage,
    mergeComposerMessage,
    fillComposerMessage,
    composerHasAutoContextMarker,
    submitComposerForm,
    getAttachmentWaitTimeout,
    isComposerReadyForNextBatch,
    waitForComposerReady,
    scheduleNextBatch,
    resetSessionState,
    finishUpload,
    settleCurrentBatch,
    enterErrorState,
    startSettlementWatcher,
    registerManualSendAttempt,
    waitForAttachments,
    injectFiles,
    attemptAutoSend,
    retryCurrentBatch,
    startNextBatch,
    togglePause,
    clearQueue,
    handleSelectedFiles,
    openFilePicker,
    getAllFiles,
    getFile,
    readAllDirectoryEntries,
    enableDragDrop
  });

  shared.__dfsWorkflowHelpers = {
    getBaseBatchCooldownMs,
    getBatchCooldownMs,
    getRemainingBatchCooldownMs,
    describeBatchCooldown,
    getAttachmentRetryDelayMs,
    resetAdaptiveBatching,
    registerAdaptiveFailure,
    registerSuccessfulBatch,
    getAdaptiveBatchingMessage
  };
})();
