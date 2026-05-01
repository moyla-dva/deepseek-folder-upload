(function () {
  'use strict';

  const shared = window.__dfsShared;
  if (!shared) return;

  const {
    state,
    ui,
    hasCurrentBatch,
    isBusyPhase,
    hasPendingWork,
    refreshTotalBatches,
    saveState,
    loadState,
    setActiveTab,
    updateAll,
    showDrawer,
    hideDrawer,
    findComposerTextarea,
    findSendButton,
    isSendButtonAvailable,
    getComposerAttachmentCount,
    observePlacement,
    schedulePlacementSync,
    registerManualSendAttempt,
    startNextBatch,
    togglePause,
    clearQueue,
    retryCurrentBatch,
    retryFailedItemsOnly,
    openFilePicker,
    enableDragDrop,
    enterErrorState,
    settleCurrentBatch
  } = shared;

  function injectStyles() {
    if (document.getElementById('dfs-redesign-style')) return;
    const style = document.createElement('style');
    style.id = 'dfs-redesign-style';
    style.textContent = `
      #dfs-uploader-root {
        --dfs-paper: rgba(255, 251, 243, 0.96);
        --dfs-paper-strong: #fff8ee;
        --dfs-ink: #1f2732;
        --dfs-muted: #66717f;
        --dfs-faint: #94a0ab;
        --dfs-line: rgba(31, 39, 50, 0.1);
        --dfs-line-strong: rgba(31, 39, 50, 0.18);
        --dfs-accent: #cb5e3d;
        --dfs-accent-deep: #9f3d22;
        --dfs-accent-soft: #f7e0d5;
        --dfs-teal: #1f7669;
        --dfs-teal-soft: #dcefeb;
        --dfs-amber: #b8741a;
        --dfs-amber-soft: #f6e8cd;
        --dfs-danger: #b24545;
        --dfs-danger-soft: #f6dede;
        --dfs-moss-soft: #e1ecd6;
        --dfs-shadow: 0 22px 56px rgba(18, 23, 29, 0.18);
        --dfs-shell-font: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        --dfs-display-font: "Iowan Old Style", "Source Han Serif SC", "Noto Serif SC", Georgia, serif;
        position: fixed;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 42px;
        height: 42px;
        font-family: var(--dfs-shell-font);
      }

      #dfs-uploader-root.is-floating {
        right: 22px;
        bottom: 120px;
      }

      #dfs-uploader-root.is-anchored {
        width: 34px;
        height: 34px;
      }

      .dfs-upload-btn {
        width: 100%;
        height: 100%;
        border-radius: 13px;
        border: 1px solid rgba(203, 94, 61, 0.38);
        background:
          radial-gradient(circle at 28% 24%, rgba(255, 255, 255, 0.78), transparent 40%),
          linear-gradient(155deg, #fff8f0 0%, #f7dece 54%, #f3c4ac 100%);
        color: var(--dfs-accent-deep);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          0 12px 26px rgba(160, 72, 42, 0.2);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition:
          transform 0.16s ease,
          box-shadow 0.18s ease,
          background 0.18s ease,
          border-color 0.18s ease,
          color 0.18s ease;
        position: relative;
        overflow: hidden;
      }

      .dfs-upload-btn::before {
        content: "";
        position: absolute;
        inset: 1px;
        border-radius: 13px;
        background: linear-gradient(180deg, rgba(255,255,255,0.58), rgba(255,255,255,0.08));
        pointer-events: none;
      }

      .dfs-upload-btn:hover {
        transform: translateY(-1px);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.8),
          0 16px 34px rgba(160, 72, 42, 0.25);
      }

      .dfs-upload-btn svg {
        width: 18px;
        height: 18px;
        position: relative;
        z-index: 1;
      }

      #dfs-uploader-root.is-anchored .dfs-upload-btn {
        border-radius: 12px;
      }

      #dfs-uploader-root.is-anchored .dfs-upload-btn::before {
        border-radius: 10px;
      }

      .dfs-upload-btn.is-injecting {
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.72), transparent 38%),
          linear-gradient(155deg, #fff7eb 0%, #f4e0bb 52%, #edc47c 100%);
        border-color: rgba(184, 116, 26, 0.42);
        color: #7a4c10;
      }

      .dfs-upload-btn.is-awaiting {
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.74), transparent 38%),
          linear-gradient(155deg, #f5fbfa 0%, #dcedea 50%, #b7ddd5 100%);
        border-color: rgba(31, 118, 105, 0.34);
        color: #14584f;
      }

      .dfs-upload-btn.is-sending {
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.74), transparent 38%),
          linear-gradient(155deg, #f3fdfb 0%, #d7f2ec 50%, #a9ddd1 100%);
        border-color: rgba(31, 118, 105, 0.42);
        color: #0e544c;
      }

      .dfs-upload-btn.is-paused {
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.66), transparent 38%),
          linear-gradient(155deg, #f6f1e9 0%, #ece4d7 52%, #ddd0bc 100%);
        border-color: rgba(111, 99, 81, 0.28);
        color: #5f5647;
      }

      .dfs-upload-btn.is-error {
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.66), transparent 38%),
          linear-gradient(155deg, #fff4f1 0%, #f5d9d6 52%, #ebb7b0 100%);
        border-color: rgba(178, 69, 69, 0.36);
        color: #842f2f;
      }

      .dfs-upload-btn.is-done {
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.66), transparent 38%),
          linear-gradient(155deg, #f7fbf1 0%, #dfead0 52%, #c3d6a9 100%);
        border-color: rgba(81, 121, 65, 0.32);
        color: #39582d;
      }

      .dfs-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 17px;
        height: 17px;
        border-radius: 999px;
        background: linear-gradient(180deg, #e4684d, #b94427);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
        font-size: 9px;
        line-height: 1;
        font-weight: 700;
        letter-spacing: 0.02em;
        border: 2px solid rgba(255, 250, 242, 0.95);
        box-shadow: 0 8px 14px rgba(168, 63, 34, 0.24);
      }

      .dfs-progress-ring {
        position: absolute;
        inset: -4px;
        border-radius: 16px;
        border: 2px solid transparent;
        pointer-events: none;
        opacity: 0;
      }

      .dfs-progress-ring.injecting {
        opacity: 0.92;
        border-color: rgba(184, 116, 26, 0.72);
        animation: dfs-breathe 1.15s ease-in-out infinite;
      }

      .dfs-progress-ring.awaiting {
        opacity: 0.92;
        border-color: rgba(31, 118, 105, 0.56);
        box-shadow: 0 0 0 2px rgba(31, 118, 105, 0.12);
      }

      .dfs-progress-ring.sending {
        opacity: 0.95;
        border-color: rgba(31, 118, 105, 0.82);
        animation: dfs-send-pulse 0.88s ease-in-out infinite;
      }

      .dfs-progress-ring.paused {
        opacity: 0.56;
        border-color: rgba(95, 86, 71, 0.44);
        border-style: dashed;
      }

      @keyframes dfs-breathe {
        0%, 100% {
          transform: scale(1);
          box-shadow: 0 0 0 0 rgba(184, 116, 26, 0.18);
        }
        50% {
          transform: scale(1.04);
          box-shadow: 0 0 0 8px rgba(184, 116, 26, 0);
        }
      }

      @keyframes dfs-send-pulse {
        0%, 100% {
          transform: scale(1);
          box-shadow: 0 0 0 0 rgba(31, 118, 105, 0.18);
        }
        50% {
          transform: scale(0.97);
          box-shadow: 0 0 0 10px rgba(31, 118, 105, 0);
        }
      }

      body.dfs-drag-over::before {
        content: "释放以上传文件或文件夹";
        position: fixed;
        inset: 0;
        z-index: 9998;
        display: flex;
        align-items: center;
        justify-content: center;
        background:
          radial-gradient(circle at top left, rgba(203, 94, 61, 0.22), transparent 28%),
          radial-gradient(circle at bottom right, rgba(31, 118, 105, 0.18), transparent 26%),
          rgba(255, 248, 238, 0.84);
        border: 2px dashed rgba(203, 94, 61, 0.42);
        color: var(--dfs-accent-deep);
        font-family: var(--dfs-display-font);
        font-size: 20px;
        letter-spacing: 0.02em;
        font-weight: 600;
        backdrop-filter: blur(5px);
      }

      .dfs-drawer {
        width: min(336px, calc(100vw - 24px));
        max-height: 418px;
        display: none;
        flex-direction: column;
        overflow: hidden;
        position: absolute;
        bottom: calc(100% + 10px);
        left: 0;
        border-radius: 18px;
        background:
          radial-gradient(circle at top left, rgba(203, 94, 61, 0.1), transparent 32%),
          radial-gradient(circle at top right, rgba(31, 118, 105, 0.08), transparent 28%),
          linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,250,242,0.92));
        border: 1px solid rgba(31, 39, 50, 0.08);
        box-shadow: var(--dfs-shadow);
        backdrop-filter: blur(18px);
        opacity: 0;
        transform: translateY(12px) scale(0.985);
        transform-origin: bottom right;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }

      .dfs-drawer::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(120deg, rgba(255,255,255,0.22), transparent 28%),
          linear-gradient(180deg, rgba(255,255,255,0.12), transparent 40%);
        pointer-events: none;
      }

      .dfs-drawer.is-open {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      #dfs-uploader-root.is-floating .dfs-drawer,
      #dfs-uploader-root.drawer-right .dfs-drawer {
        left: auto;
        right: 0;
      }

      .dfs-drawer-header,
      .dfs-drawer-tabs,
      .dfs-drawer-body,
      .dfs-drawer-footer {
        position: relative;
        z-index: 1;
      }

      .dfs-drawer-header {
        padding: 11px 13px 10px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        border-bottom: 1px solid rgba(31, 39, 50, 0.06);
        gap: 11px;
      }

      .dfs-header-copy {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }

      .dfs-drawer-eyebrow {
        font-size: 9px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--dfs-accent-deep);
        font-weight: 700;
      }

      .dfs-drawer-title {
        font-family: var(--dfs-display-font);
        font-size: 18px;
        line-height: 1.05;
        color: var(--dfs-ink);
        font-weight: 600;
      }

      .dfs-drawer-subtitle {
        font-size: 10px;
        line-height: 1.45;
        color: var(--dfs-muted);
      }

      .dfs-chip-row {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .dfs-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 10px;
        line-height: 1;
        padding: 6px 9px;
        border-radius: 999px;
        font-weight: 700;
        letter-spacing: 0.01em;
        border: 1px solid transparent;
      }

      .dfs-chip::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.72;
      }

      .dfs-chip.sand { background: #f4ebdc; color: #8a6430; border-color: rgba(138,100,48,0.14); }
      .dfs-chip.teal { background: var(--dfs-teal-soft); color: var(--dfs-teal); border-color: rgba(31,118,105,0.12); }
      .dfs-chip.slate { background: #e7ecf0; color: #4e5a68; border-color: rgba(78,90,104,0.12); }
      .dfs-chip.amber { background: var(--dfs-amber-soft); color: #865410; border-color: rgba(184,116,26,0.12); }
      .dfs-chip.red { background: var(--dfs-danger-soft); color: #922f2f; border-color: rgba(178,69,69,0.12); }
      .dfs-chip.gray { background: #ece6dc; color: #5f5647; border-color: rgba(95,86,71,0.1); }
      .dfs-chip.green { background: var(--dfs-moss-soft); color: #446337; border-color: rgba(81,121,65,0.12); }

      .dfs-drawer-tabs {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 5px;
        padding: 8px 13px 0;
      }

      .dfs-drawer-tab {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
        border: 1px solid rgba(31, 39, 50, 0.06);
        border-radius: 999px;
        color: var(--dfs-muted);
        background: rgba(255,255,255,0.4);
        cursor: pointer;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.02em;
        transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
      }

      .dfs-drawer-tab:hover {
        transform: translateY(-1px);
        border-color: rgba(203, 94, 61, 0.18);
        color: var(--dfs-accent-deep);
      }

      .dfs-drawer-tab.active {
        background: linear-gradient(180deg, #fff9f2, #f9e5d9);
        border-color: rgba(203, 94, 61, 0.24);
        color: var(--dfs-accent-deep);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.74);
      }

      .dfs-drawer-body {
        padding: 11px 13px 10px;
        overflow: auto;
        min-height: 164px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .dfs-progress-card,
      .dfs-panel-card,
      .dfs-settings-card,
      .dfs-hero-card {
        border-radius: 15px;
        border: 1px solid rgba(31, 39, 50, 0.08);
        background: rgba(255, 255, 255, 0.68);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.72);
      }

      .dfs-progress-card,
      .dfs-panel-card,
      .dfs-settings-card {
        padding: 11px;
      }

      .dfs-hero-card {
        padding: 16px 13px;
      }

      .dfs-hero-card.is-success {
        background: linear-gradient(180deg, rgba(247,251,241,0.96), rgba(230,240,220,0.88));
        border-color: rgba(81,121,65,0.14);
      }

      .dfs-hero-card.is-muted {
        background: linear-gradient(180deg, rgba(249,245,238,0.96), rgba(243,237,227,0.88));
      }

      .dfs-card-kicker,
      .dfs-section-kicker {
        font-size: 9px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--dfs-accent-deep);
        font-weight: 700;
        margin-bottom: 6px;
      }

      .dfs-empty-title {
        margin: 0 0 7px;
        font-family: var(--dfs-display-font);
        font-size: 17px;
        line-height: 1.08;
        color: var(--dfs-ink);
      }

      .dfs-empty-copy {
        margin: 0;
        font-size: 11px;
        line-height: 1.58;
        color: var(--dfs-muted);
      }

      .dfs-empty-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 13px;
      }

      .dfs-progress-top,
      .dfs-section-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .dfs-progress-count {
        font-family: var(--dfs-display-font);
        font-size: 20px;
        line-height: 1;
        color: var(--dfs-ink);
      }

      .dfs-progress-caption,
      .dfs-queue-summary,
      .dfs-panel-meta,
      .dfs-setting-help {
        font-size: 10px;
        line-height: 1.5;
        color: var(--dfs-muted);
      }

      .dfs-progress-bar {
        margin-top: 11px;
        height: 7px;
        border-radius: 999px;
        background: rgba(31,39,50,0.08);
        overflow: hidden;
      }

      .dfs-progress-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--dfs-accent) 0%, #e39a5d 42%, var(--dfs-teal) 100%);
        box-shadow: 0 0 12px rgba(203, 94, 61, 0.18);
      }

      .dfs-metric-row {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 11px;
      }

      .dfs-metric {
        padding: 8px 8px 7px;
        border-radius: 12px;
        background: rgba(255,255,255,0.74);
        border: 1px solid rgba(31,39,50,0.06);
      }

      .dfs-metric-label {
        display: block;
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--dfs-faint);
        margin-bottom: 4px;
      }

      .dfs-metric-value {
        font-size: 15px;
        line-height: 1;
        color: var(--dfs-ink);
      }

      .dfs-notice {
        padding: 9px 10px;
        border-radius: 12px;
        font-size: 10px;
        line-height: 1.52;
        margin: 0;
        border: 1px solid transparent;
      }

      .dfs-notice.warning { background: #f7edd6; color: #6f4a12; border-color: rgba(184,116,26,0.14); }
      .dfs-notice.error { background: #f9e3de; color: #832d2d; border-color: rgba(178,69,69,0.14); }
      .dfs-notice.muted { background: #f1ebe3; color: #5e5648; border-color: rgba(95,86,71,0.12); }

      .dfs-section-label {
        font-family: var(--dfs-display-font);
        font-size: 16px;
        line-height: 1.05;
        color: var(--dfs-ink);
        font-weight: 600;
      }

      .dfs-panel-card.tone-current {
        background: linear-gradient(180deg, rgba(255,252,246,0.94), rgba(250,236,224,0.82));
      }

      .dfs-panel-card.tone-queue {
        background: linear-gradient(180deg, rgba(249,252,251,0.94), rgba(230,242,239,0.82));
      }

      .dfs-panel-card.tone-log {
        background: linear-gradient(180deg, rgba(249,248,252,0.94), rgba(235,233,244,0.82));
      }

      .dfs-panel-card.tone-skip {
        background: linear-gradient(180deg, rgba(251,247,241,0.94), rgba(245,236,226,0.82));
      }

      .dfs-file-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin-top: 10px;
      }

      .dfs-file-grid.is-compact {
        margin-top: 8px;
      }

      .dfs-file-chip {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        max-width: 100%;
        padding: 6px 9px;
        border-radius: 11px;
        background: rgba(255,255,255,0.86);
        border: 1px solid rgba(31,39,50,0.08);
        font-size: 10px;
        color: #3b4653;
        box-shadow: 0 8px 16px rgba(25, 33, 41, 0.04);
      }

      .dfs-file-chip-more {
        color: var(--dfs-muted);
        background: rgba(251,247,241,0.96);
      }

      .dfs-file-name {
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dfs-file-icon {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #d7c4b7;
        flex: none;
        box-shadow: inset 0 0 0 2px rgba(255,255,255,0.56);
      }

      .dfs-file-icon.pdf { background: #d46b54; }
      .dfs-file-icon.doc { background: #6f91bf; }
      .dfs-file-icon.sheet { background: #58a37e; }

      .dfs-file-chip .remove-btn {
        cursor: pointer;
        color: var(--dfs-accent);
        font-weight: 700;
      }

      .dfs-log-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 10px;
      }

      .dfs-log-item {
        padding: 9px 10px;
        border-radius: 12px;
        background: rgba(255,255,255,0.74);
        border: 1px solid rgba(31,39,50,0.06);
      }

      .dfs-log-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .dfs-log-title {
        font-size: 10px;
        line-height: 1.5;
        color: var(--dfs-ink);
        font-weight: 700;
      }

      .dfs-log-note {
        margin-top: 7px;
        font-size: 10px;
        line-height: 1.52;
        color: var(--dfs-muted);
      }

      .dfs-skip-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 0;
        font-size: 10px;
        border-bottom: 1px dashed rgba(31,39,50,0.08);
      }

      .dfs-skip-item:last-child { border-bottom: 0; }
      .dfs-skip-name { color: var(--dfs-ink); }

      .dfs-settings-card + .dfs-settings-card,
      .dfs-panel-card + .dfs-panel-card,
      .dfs-progress-card + .dfs-panel-card {
        margin-top: 0;
      }

      .dfs-setting-row {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 10px;
      }

      .dfs-setting-row:last-child { margin-bottom: 0; }

      .dfs-setting-row label,
      .dfs-setting-column label {
        color: var(--dfs-ink);
        font-size: 11px;
        font-weight: 700;
      }

      .dfs-setting-row label {
        width: 86px;
        flex: none;
      }

      .dfs-setting-row input,
      .dfs-setting-row select,
      .dfs-setting-column input,
      .dfs-setting-column textarea {
        flex: 1;
        width: 100%;
        font-size: 11px;
        color: var(--dfs-ink);
        border: 1px solid rgba(31,39,50,0.1);
        border-radius: 10px;
        padding: 8px 10px;
        background: rgba(255,255,255,0.9);
        box-sizing: border-box;
        transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
        font-family: var(--dfs-shell-font);
      }

      .dfs-setting-row input:focus,
      .dfs-setting-row select:focus,
      .dfs-setting-column input:focus,
      .dfs-setting-column textarea:focus {
        outline: none;
        border-color: rgba(203,94,61,0.4);
        box-shadow: 0 0 0 4px rgba(203,94,61,0.1);
        background: rgba(255,255,255,0.98);
      }

      .dfs-setting-column {
        display: flex;
        flex-direction: column;
        gap: 7px;
      }

      .dfs-setting-column + .dfs-setting-column {
        margin-top: 12px;
      }

      .dfs-setting-column textarea {
        min-height: 72px;
        resize: vertical;
      }

      .dfs-setting-column input[type="range"] {
        padding: 0;
        height: 20px;
        border: 0;
        border-radius: 999px;
        background: transparent;
        box-shadow: none;
        accent-color: var(--dfs-accent);
      }

      .dfs-setting-column input[type="range"]:focus {
        box-shadow: none;
        background: transparent;
      }

      .dfs-drawer-footer {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 13px 11px;
        border-top: 1px solid rgba(31, 39, 50, 0.06);
        background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,249,240,0.72));
      }

      .dfs-btn {
        border: 1px solid rgba(31,39,50,0.08);
        background: rgba(255,255,255,0.76);
        color: var(--dfs-muted);
        border-radius: 999px;
        padding: 7px 12px;
        font-size: 10px;
        line-height: 1;
        font-weight: 700;
        cursor: pointer;
        transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
      }

      .dfs-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 10px 18px rgba(20, 27, 35, 0.08);
      }

      .dfs-btn.primary {
        background: linear-gradient(180deg, #e2734a, #c64f2c);
        border-color: rgba(198,79,44,0.24);
        color: white;
      }

      .dfs-btn.warn {
        background: linear-gradient(180deg, #f6ecd7, #ecd7a8);
        border-color: rgba(184,116,26,0.16);
        color: #6f4a12;
      }

      .dfs-btn.danger {
        background: linear-gradient(180deg, #f7e5e2, #edc1bb);
        border-color: rgba(178,69,69,0.16);
        color: #812a2a;
      }

      .dfs-btn.ghost {
        background: rgba(255,255,255,0.58);
        color: var(--dfs-accent-deep);
      }

      .dfs-btn[hidden] { display: none !important; }
      .dfs-btn:disabled { opacity: 0.46; cursor: not-allowed; transform: none; box-shadow: none; }
      .dfs-btn.spacer { margin-left: auto; }

      .dfs-confirm-overlay {
        position: fixed;
        inset: 0;
        z-index: 10001;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(21, 26, 31, 0.28);
        backdrop-filter: blur(10px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.16s ease;
      }

      .dfs-confirm-overlay.is-open {
        opacity: 1;
        pointer-events: auto;
      }

      .dfs-confirm-dialog {
        width: min(320px, calc(100vw - 32px));
        padding: 14px;
        border-radius: 16px;
        border: 1px solid rgba(31, 39, 50, 0.08);
        background:
          radial-gradient(circle at top left, rgba(203, 94, 61, 0.1), transparent 34%),
          linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,249,240,0.94));
        box-shadow: 0 20px 44px rgba(18, 23, 29, 0.22);
        transform: translateY(8px) scale(0.985);
        transition: transform 0.16s ease;
      }

      .dfs-confirm-overlay.is-open .dfs-confirm-dialog {
        transform: translateY(0) scale(1);
      }

      .dfs-confirm-kicker {
        margin-bottom: 6px;
        font-size: 9px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--dfs-accent-deep);
        font-weight: 700;
      }

      .dfs-confirm-title {
        margin: 0 0 7px;
        font-family: var(--dfs-display-font);
        font-size: 17px;
        line-height: 1.1;
        color: var(--dfs-ink);
      }

      .dfs-confirm-message {
        margin: 0;
        font-size: 11px;
        line-height: 1.58;
        color: var(--dfs-muted);
      }

      .dfs-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }

      @media (max-width: 560px) {
        #dfs-uploader-root.is-floating { right: 12px; bottom: 96px; }
        .dfs-drawer {
          width: min(92vw, 336px);
          max-height: min(76vh, 418px);
        }
        .dfs-metric-row {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .dfs-setting-row {
          flex-direction: column;
          align-items: stretch;
        }
        .dfs-setting-row label {
          width: auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.className = 'dfs-upload-btn';
    btn.type = 'button';
    btn.title = '批量上传工作台';
    btn.innerHTML = `
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <path d="M4 13v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2"/>
        <path d="M10 3v9"/>
        <path d="M7 6l3-3 3 3"/>
      </svg>
    `;
    return btn;
  }

  function createDrawer() {
    const drawer = document.createElement('div');
    drawer.className = 'dfs-drawer';
    drawer.innerHTML = `
      <div class="dfs-drawer-header">
        <div class="dfs-header-copy">
          <span class="dfs-drawer-eyebrow">DeepSeek Uploader</span>
          <span class="dfs-drawer-title">批量上传工作台</span>
          <span class="dfs-drawer-subtitle">把多批资料稳定送进同一轮对话上下文，并在需要时停留给你确认。</span>
        </div>
        <div class="dfs-chip-row">
          <span id="dfs-source-chip" class="dfs-chip sand"></span>
          <span id="dfs-mode-chip" class="dfs-chip teal"></span>
        </div>
      </div>
      <div class="dfs-drawer-tabs">
        <button type="button" class="dfs-drawer-tab active" data-tab="queue" id="dfs-tab-queue">队列</button>
        <button type="button" class="dfs-drawer-tab" data-tab="skipped" id="dfs-tab-skipped">已跳过</button>
        <button type="button" class="dfs-drawer-tab" data-tab="settings" id="dfs-tab-settings">设置</button>
      </div>
      <div class="dfs-drawer-body" id="dfs-drawer-body"></div>
      <div class="dfs-drawer-footer">
        <button type="button" class="dfs-btn warn" id="dfs-pause-btn">暂停</button>
        <button type="button" class="dfs-btn danger" id="dfs-clear-btn">清空</button>
        <button type="button" class="dfs-btn ghost" id="dfs-retry-failed-btn" hidden>仅重试失败项</button>
        <button type="button" class="dfs-btn ghost" id="dfs-retry-btn" hidden>重试本批</button>
        <button type="button" class="dfs-btn primary" id="dfs-continue-btn">继续下一批</button>
      </div>
    `;
    return drawer;
  }

  function createConfirmDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'dfs-confirm-overlay';
    overlay.innerHTML = `
      <div class="dfs-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="dfs-confirm-title">
        <div class="dfs-confirm-kicker">Confirm</div>
        <h3 class="dfs-confirm-title" id="dfs-confirm-title">请确认操作</h3>
        <p class="dfs-confirm-message" id="dfs-confirm-message"></p>
        <div class="dfs-confirm-actions">
          <button type="button" class="dfs-btn ghost" id="dfs-confirm-cancel">取消</button>
          <button type="button" class="dfs-btn primary" id="dfs-confirm-accept">继续</button>
        </div>
      </div>
    `;
    return overlay;
  }

  function settleConfirmation(accepted) {
    if (!ui.confirmOverlay) return;
    const resolve = ui.confirmResolve;
    ui.confirmResolve = null;
    ui.confirmOverlay.classList.remove('is-open');
    if (resolve) resolve(Boolean(accepted));
  }

  function requestConfirmation(message, options = {}) {
    if (!ui.confirmOverlay) {
      return Promise.resolve(window.confirm(message));
    }

    if (ui.confirmResolve) {
      const previousResolve = ui.confirmResolve;
      ui.confirmResolve = null;
      previousResolve(false);
    }

    const title = options.title || '请确认操作';
    const confirmText = options.confirmText || '继续';
    const cancelText = options.cancelText || '取消';
    const tone = options.tone === 'danger' ? 'danger' : 'primary';

    ui.confirmTitle.textContent = title;
    ui.confirmMessage.textContent = message;
    ui.confirmCancelBtn.textContent = cancelText;
    ui.confirmAcceptBtn.textContent = confirmText;
    ui.confirmAcceptBtn.className = `dfs-btn ${tone}`;
    ui.confirmOverlay.classList.add('is-open');

    return new Promise(resolve => {
      ui.confirmResolve = resolve;
      requestAnimationFrame(() => ui.confirmAcceptBtn?.focus());
    });
  }

  function mountUI() {
    if (document.getElementById('dfs-uploader-root')) return;

    injectStyles();
    loadState();

    const wrapper = document.createElement('div');
    wrapper.id = 'dfs-uploader-root';
    wrapper.className = 'is-floating drawer-right';
    ui.btn = createButton();
    ui.drawer = createDrawer();
    ui.confirmOverlay = createConfirmDialog();
    wrapper.appendChild(ui.drawer);
    wrapper.appendChild(ui.btn);
    wrapper.appendChild(ui.confirmOverlay);
    document.body.appendChild(wrapper);
    ui.wrapper = wrapper;
    ui.confirmTitle = ui.confirmOverlay.querySelector('#dfs-confirm-title');
    ui.confirmMessage = ui.confirmOverlay.querySelector('#dfs-confirm-message');
    ui.confirmCancelBtn = ui.confirmOverlay.querySelector('#dfs-confirm-cancel');
    ui.confirmAcceptBtn = ui.confirmOverlay.querySelector('#dfs-confirm-accept');

    ui.confirmOverlay.addEventListener('click', event => {
      if (event.target === ui.confirmOverlay) {
        settleConfirmation(false);
      }
    });

    ui.confirmCancelBtn.addEventListener('click', () => settleConfirmation(false));
    ui.confirmAcceptBtn.addEventListener('click', () => settleConfirmation(true));

    ui.btn.addEventListener('click', event => {
      if (event.shiftKey && !isBusyPhase() && !hasPendingWork()) {
        openFilePicker(state.uploadSource);
        return;
      }
      showDrawer('queue');
    });

    ui.drawer.addEventListener('click', async event => {
      const tab = event.target.closest('.dfs-drawer-tab');
      if (tab) {
        setActiveTab(tab.dataset.tab);
        return;
      }
      if (event.target.id === 'dfs-pick-folder-btn') {
        openFilePicker('folder');
        return;
      }
      if (event.target.id === 'dfs-pick-files-btn') {
        openFilePicker('files');
        return;
      }
      const queueRemove = event.target.closest('[data-queue-index]');
      if (queueRemove) {
        const index = Number(queueRemove.dataset.queueIndex);
        if (Number.isInteger(index)) {
          state.queue.splice(index, 1);
          refreshTotalBatches();
          saveState();
          updateAll();
        }
        return;
      }
      const skippedAdd = event.target.closest('[data-skip-index]');
      if (skippedAdd) {
        const index = Number(skippedAdd.dataset.skipIndex);
        if (Number.isInteger(index)) {
          const item = state.skipped.splice(index, 1)[0];
          if (item) {
            state.queue.push(item);
            refreshTotalBatches();
            updateAll();
            saveState();
          }
        }
        return;
      }
      if (event.target.id === 'dfs-pause-btn') togglePause();
      if (event.target.id === 'dfs-clear-btn') await clearQueue();
      if (event.target.id === 'dfs-retry-failed-btn') await retryFailedItemsOnly();
      if (event.target.id === 'dfs-retry-btn') retryCurrentBatch();
      if (event.target.id === 'dfs-continue-btn' && !isBusyPhase()) {
        if (hasCurrentBatch() && ['awaiting_send', 'paused', 'error'].includes(state.phase)) {
          const attachmentsStillVisible = getComposerAttachmentCount() > state.composerBaselineAttachments;
          if (!state.currentBatchAttachmentsConfirmed && attachmentsStillVisible) {
            enterErrorState('当前批次附件尚未确认完整。请先检查输入框中的附件；如有残留请先清空，再点击“重试本批”。', {
              errorType: 'attachment_confirm_incomplete',
              clearFailureContext: false
            });
            return;
          }
          settleCurrentBatch(true, true);
          if (state.queue.length) await startNextBatch(state.uploadMode);
        } else if (state.queue.length) {
          await startNextBatch(state.uploadMode);
        } else {
          hideDrawer();
        }
      }
    });

    document.addEventListener('click', event => {
      const sendBtn = event.target.closest('button, [role="button"], input[type="submit"]');
      if (!sendBtn) return;
      const actualSendButton = findSendButton();
      if (!actualSendButton || sendBtn !== actualSendButton) return;
      if (!isSendButtonAvailable()) return;
      registerManualSendAttempt();
    }, true);

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && ui.confirmOverlay?.classList.contains('is-open')) {
        event.preventDefault();
        event.stopPropagation();
        settleConfirmation(false);
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      const textarea = findComposerTextarea();
      if (!textarea || event.target !== textarea) return;
      if (!isSendButtonAvailable()) return;
      registerManualSendAttempt();
    }, true);

    document.addEventListener('click', event => {
      if (!ui.wrapper.contains(event.target)) hideDrawer();
    });

    enableDragDrop();
    observePlacement();
    schedulePlacementSync(0);
    updateAll();
  }

  Object.assign(shared, {
    injectStyles,
    createButton,
    createDrawer,
    requestConfirmation,
    mountUI
  });
})();
