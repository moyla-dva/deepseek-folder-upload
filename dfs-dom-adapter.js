(function () {
  'use strict';

  const shared = window.__dfsShared;
  if (!shared) return;

  const {
    STOP_KEYWORD_RE,
    SEND_KEYWORD_RE,
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
    scheduleDomCacheInvalidation,
    getCachedDomValue,
    getCachedAttachmentElements
  } = shared;

  // These thresholds are tuned against the current DeepSeek composer layout.
  // Keep them centralized so later DOM retuning only needs one edit pass.
  const DOM_TUNING = {
    ATTACHMENT_TEXT_MAX_LENGTH: 140,
    GENERIC_TEXTAREA_ROW_TOLERANCE: 40,
    LOCAL_COMPOSER_ROW_TOLERANCE: 28,
    SHARED_CONTAINER_MIN_CONTROLS: 2,
    SHARED_CONTAINER_MAX_CONTROLS: 8,
    ATTACHMENT_ROOT_MAX_ANCESTOR_STEPS: 4,
    COMPOSER_ROOT_MIN_WIDTH: 260,
    COMPOSER_ROOT_MIN_HEIGHT: 80,
    COMPOSER_ROOT_MAX_VIEWPORT_HEIGHT_RATIO: 0.7,
    COMPOSER_ROOT_MAX_CHILDREN: 35,
    COMPOSER_ROOT_NEAR_ANCESTOR_MAX_DISTANCE: 4,
    NATIVE_UPLOAD_CLOSE_CENTER_OFFSET: 56,
    NATIVE_UPLOAD_NEAR_LEFT_EDGE_OFFSET: 20,
    NATIVE_UPLOAD_SEND_GAP_TIGHT: 16,
    NATIVE_UPLOAD_SEND_GAP_LOOSE: 48
  };

  const COMPOSER_ROOT_SCORE = {
    FORM: 4,
    CONTROLS_AT_LEAST_THREE: 5,
    CONTROLS_AT_LEAST_FIVE: 3,
    ACTION_BUTTONS_AT_LEAST_ONE: 5,
    ACTION_BUTTONS_AT_LEAST_TWO: 6,
    TEXT_HINT: 6,
    TEXTAREA_PARENT: 8,
    TEXTAREA_NEAR_ANCESTOR: 4,
    DISTANT_ANCESTOR_PENALTY: -5,
    MIN_WIDTH: 2,
    MIN_HEIGHT: 2,
    TOO_TALL_PENALTY: -6,
    TOO_MANY_CHILDREN_PENALTY: -4
  };

  const UPLOAD_INPUT_SCORE = {
    MULTIPLE: 4,
    HIDDEN: 3,
    ACCEPT: 1,
    INSIDE_LOCAL_ROOT: 10,
    SAME_FORM_AS_TEXTAREA: 8
  };

  const SEND_SCORE = {
    TEST_ID: 10,
    EXPLICIT_LABEL: 8,
    SUBMIT_CONTROL: 7,
    SEND_KEYWORD: 6,
    ICON_HINT: 2,
    SEARCH_PENALTY: -6,
    SAME_FORM: 5,
    INSIDE_COMPOSER: 4,
    ROOT_IS_FORM: 4,
    ROOT_IS_COMPOSER: 2,
    AFTER_TEXTAREA: 4,
    BEFORE_TEXTAREA: -4,
    ACTION_BUTTON: 6,
    ACTION_BUTTON_LAST: 10,
    ACTION_BUTTON_FIRST_PENALTY: -2,
    DISABLED_PENALTY: -1,
    MIN_ACCEPTED_SCORE: 4,
    MIN_FALLBACK_ACTION_BUTTONS: 2
  };

  const UPLOAD_ANCHOR_SCORE = {
    DEFAULT_AFTER_TEXTAREA: 0,
    DEFAULT_BEFORE_TEXTAREA: -12,
    SAME_ROW_AFTER_TEXTAREA: 18,
    SAME_ROW_BEFORE_TEXTAREA: 14,
    CLOSE_CENTER_AFTER_TEXTAREA: 8,
    FAR_FROM_ROW_PENALTY: -10,
    RIGHT_OF_TEXTAREA: 10,
    AFTER_SEND_BUTTON: 22,
    SAME_PARENT_AS_SEND: 8,
    LOCAL_CONTAINER: 10,
    TEXTAREA_PARENT: 6,
    EMPTY_LABEL: 6,
    UPLOAD_KEYWORD: 10,
    MATCHES_SEND_PENALTY: -24,
    TIGHT_GAP_TO_SEND: 12,
    LOOSE_GAP_TO_SEND: 6,
    BEFORE_TEXTAREA_LEFT_EDGE: 6,
    BEFORE_TEXTAREA_UPLOAD_KEYWORD: 8,
    MIN_ACCEPTED_SCORE: 8
  };

  const UI_PLACEMENT = {
    BUTTON_SIZE: 36,
    GAP: 8,
    VIEWPORT_MARGIN: 12
  };

  function scoreComposerRootFeatures(features) {
    let score = 0;
    if (features.isForm) score += COMPOSER_ROOT_SCORE.FORM;
    if ((features.controlsCount || 0) >= 3) score += COMPOSER_ROOT_SCORE.CONTROLS_AT_LEAST_THREE;
    if ((features.controlsCount || 0) >= 5) score += COMPOSER_ROOT_SCORE.CONTROLS_AT_LEAST_FIVE;
    if ((features.actionButtonsCount || 0) >= 1) score += COMPOSER_ROOT_SCORE.ACTION_BUTTONS_AT_LEAST_ONE;
    if ((features.actionButtonsCount || 0) >= 2) score += COMPOSER_ROOT_SCORE.ACTION_BUTTONS_AT_LEAST_TWO;
    if (features.hasTextHint) score += COMPOSER_ROOT_SCORE.TEXT_HINT;
    if (features.ancestorDistance === 1) score += COMPOSER_ROOT_SCORE.TEXTAREA_PARENT;
    else if ((features.ancestorDistance || 0) > 1 && features.ancestorDistance <= DOM_TUNING.COMPOSER_ROOT_NEAR_ANCESTOR_MAX_DISTANCE) {
      score += COMPOSER_ROOT_SCORE.TEXTAREA_NEAR_ANCESTOR;
    } else if ((features.ancestorDistance || 0) > DOM_TUNING.COMPOSER_ROOT_NEAR_ANCESTOR_MAX_DISTANCE) {
      score += COMPOSER_ROOT_SCORE.DISTANT_ANCESTOR_PENALTY;
    }
    if ((features.width || 0) >= DOM_TUNING.COMPOSER_ROOT_MIN_WIDTH) score += COMPOSER_ROOT_SCORE.MIN_WIDTH;
    if ((features.height || 0) >= DOM_TUNING.COMPOSER_ROOT_MIN_HEIGHT) score += COMPOSER_ROOT_SCORE.MIN_HEIGHT;
    if ((features.viewportHeight || 0) > 0 && (features.height || 0) > features.viewportHeight * DOM_TUNING.COMPOSER_ROOT_MAX_VIEWPORT_HEIGHT_RATIO) {
      score += COMPOSER_ROOT_SCORE.TOO_TALL_PENALTY;
    }
    if ((features.childElementCount || 0) > DOM_TUNING.COMPOSER_ROOT_MAX_CHILDREN) {
      score += COMPOSER_ROOT_SCORE.TOO_MANY_CHILDREN_PENALTY;
    }
    return score;
  }

  function scoreSendControlFeatures(features) {
    if (features.isStopOnlyControl || features.isUploadOnlyControl) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    if (features.matchesTestId) score += SEND_SCORE.TEST_ID;
    if (features.hasExplicitSendLabel) score += SEND_SCORE.EXPLICIT_LABEL;
    if (features.isSubmitControl) score += SEND_SCORE.SUBMIT_CONTROL;
    if (features.hasSendKeyword) score += SEND_SCORE.SEND_KEYWORD;
    if (features.hasIconHint) score += SEND_SCORE.ICON_HINT;
    if (features.hasSearchExclusion) score += SEND_SCORE.SEARCH_PENALTY;
    if (features.isSameForm) score += SEND_SCORE.SAME_FORM;
    if (features.isInsideComposer) score += SEND_SCORE.INSIDE_COMPOSER;
    if (features.rootKind === 'form') score += SEND_SCORE.ROOT_IS_FORM;
    else if (features.rootKind === 'composer') score += SEND_SCORE.ROOT_IS_COMPOSER;
    if (features.isAfterTextarea) score += SEND_SCORE.AFTER_TEXTAREA;
    else if (features.isBeforeTextarea) score += SEND_SCORE.BEFORE_TEXTAREA;
    if (features.isActionButton) score += SEND_SCORE.ACTION_BUTTON;
    if (features.isLastActionButton) score += SEND_SCORE.ACTION_BUTTON_LAST;
    if (features.isFirstActionButton) score += SEND_SCORE.ACTION_BUTTON_FIRST_PENALTY;
    if (features.isDisabled) score += SEND_SCORE.DISABLED_PENALTY;
    return score;
  }

  function scoreUploadAnchorFeatures(features) {
    let score = Number.NEGATIVE_INFINITY;

    if (features.isAfterTextarea) {
      score = UPLOAD_ANCHOR_SCORE.DEFAULT_AFTER_TEXTAREA;
      if (features.isSameRow) score += UPLOAD_ANCHOR_SCORE.SAME_ROW_AFTER_TEXTAREA;
      else if (features.isCenterOffsetClose) score += UPLOAD_ANCHOR_SCORE.CLOSE_CENTER_AFTER_TEXTAREA;
      else score += UPLOAD_ANCHOR_SCORE.FAR_FROM_ROW_PENALTY;

      if (features.isRightOfTextarea) score += UPLOAD_ANCHOR_SCORE.RIGHT_OF_TEXTAREA;
      if (features.isAfterSendButton) score += UPLOAD_ANCHOR_SCORE.AFTER_SEND_BUTTON;
      if (features.isSameParentAsSend) score += UPLOAD_ANCHOR_SCORE.SAME_PARENT_AS_SEND;
      if (features.isLocalContainer) score += UPLOAD_ANCHOR_SCORE.LOCAL_CONTAINER;
      if (features.isTextareaParent) score += UPLOAD_ANCHOR_SCORE.TEXTAREA_PARENT;
      if (features.hasEmptyLabel) score += UPLOAD_ANCHOR_SCORE.EMPTY_LABEL;
      if (features.hasUploadKeyword) score += UPLOAD_ANCHOR_SCORE.UPLOAD_KEYWORD;
      if (features.isSendButton) score += UPLOAD_ANCHOR_SCORE.MATCHES_SEND_PENALTY;
      if (features.hasTightGapToSend) score += UPLOAD_ANCHOR_SCORE.TIGHT_GAP_TO_SEND;
      else if (features.hasLooseGapToSend) score += UPLOAD_ANCHOR_SCORE.LOOSE_GAP_TO_SEND;
      return score;
    }

    if (features.isBeforeTextarea) {
      score = UPLOAD_ANCHOR_SCORE.DEFAULT_BEFORE_TEXTAREA;
      if (features.isSameRow) score += UPLOAD_ANCHOR_SCORE.SAME_ROW_BEFORE_TEXTAREA;
      if (features.isNearTextareaLeftEdge) score += UPLOAD_ANCHOR_SCORE.BEFORE_TEXTAREA_LEFT_EDGE;
      if (features.hasUploadKeyword) score += UPLOAD_ANCHOR_SCORE.BEFORE_TEXTAREA_UPLOAD_KEYWORD;
    }

    return score;
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      element.getClientRects().length > 0;
  }

  function getControlLabel(control) {
    const className = typeof control.className === 'string' ? control.className : '';
    return [
      control.getAttribute('aria-label'),
      control.getAttribute('title'),
      control.getAttribute('data-testid'),
      control.getAttribute('name'),
      control.getAttribute('type'),
      className,
      control.textContent
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function getElementText(element) {
    return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeSearchText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function cleanDetectedFileName(name) {
    return normalizeSearchText(name)
      .replace(/^[`"'“”‘’([{<\s]+/, '')
      .replace(/[`"'“”‘’)\]}>:;,\s]+$/, '');
  }

  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripKnownFileNames(text, fileNames) {
    let output = normalizeSearchText(text);
    fileNames.forEach(fileName => {
      if (!fileName) return;
      output = output.replace(new RegExp(escapeRegExp(fileName), 'g'), ' ');
    });
    return output.replace(/\s+/g, ' ').trim();
  }

  function extractDetectedFileNames(texts) {
    const detected = new Set();
    const regex = new RegExp(ATTACHMENT_NAME_RE.source, 'ig');

    texts.forEach(text => {
      for (const match of String(text || '').matchAll(regex)) {
        const cleaned = cleanDetectedFileName(match[0]);
        if (cleaned) detected.add(cleaned);
      }
    });

    return detected;
  }

  function isElementAfter(anchor, target) {
    if (!anchor || !target || anchor === target) return false;
    return Boolean(anchor.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function getAncestorDistance(descendant, ancestor) {
    if (!(descendant instanceof HTMLElement) || !(ancestor instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
    let distance = 0;
    let node = descendant.parentElement;

    while (node && node !== document.body) {
      distance += 1;
      if (node === ancestor) return distance;
      node = node.parentElement;
    }

    return Number.POSITIVE_INFINITY;
  }

  function getVisibleControls(root) {
    if (!(root instanceof HTMLElement)) return [];
    return Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(control => (
      control instanceof HTMLElement &&
      isElementVisible(control) &&
      !ui.wrapper?.contains(control)
    ));
  }

  function hasNestedAttachmentLikeChild(element) {
    if (!(element instanceof HTMLElement)) return false;
    return Array.from(element.children).some(child => {
      if (!(child instanceof HTMLElement)) return false;
      const childText = getElementText(child);
      return Boolean(
        childText &&
        ATTACHMENT_NAME_RE.test(childText) &&
        ATTACHMENT_SIZE_RE.test(childText)
      );
    });
  }

  function findAttachmentContainer(element, root) {
    let node = element instanceof HTMLElement ? element : null;
    let best = null;

    while (node && node !== root && node !== document.body) {
      if (node.querySelector('textarea')) break;
      const text = getElementText(node);
      if (
        ATTACHMENT_NAME_RE.test(text) &&
        ATTACHMENT_SIZE_RE.test(text) &&
        text.length <= DOM_TUNING.ATTACHMENT_TEXT_MAX_LENGTH &&
        !hasNestedAttachmentLikeChild(node)
      ) {
        best = node;
      }
      node = node.parentElement;
    }

    return best || (element instanceof HTMLElement ? element : null);
  }

  function getAttachmentSearchRoots(root, textarea = findComposerTextarea(), composerForm = getComposerForm()) {
    if (!(textarea instanceof HTMLElement)) {
      return root instanceof HTMLElement ? [root] : [];
    }

    const roots = [];
    const seen = new Set();
    const pushRoot = candidate => {
      if (!(candidate instanceof HTMLElement) || seen.has(candidate)) return;
      seen.add(candidate);
      roots.push(candidate);
    };

    let node = textarea.parentElement;
    let steps = 0;

    while (node && node !== document.body) {
      pushRoot(node);
      if (node === composerForm || node.matches('form')) break;
      steps += 1;
      if (steps >= DOM_TUNING.ATTACHMENT_ROOT_MAX_ANCESTOR_STEPS) break;
      node = node.parentElement;
    }

    pushRoot(composerForm);

    if (!roots.length && root instanceof HTMLElement) {
      pushRoot(root);
    }

    return roots;
  }

  function collectAttachmentElements(root) {
    return getCachedAttachmentElements(root, () => {
      const set = new Set();
      const searchRoots = getAttachmentSearchRoots(root);

      searchRoots.forEach(searchRoot => {
        ATTACHMENT_SELECTORS.forEach(selector => {
          searchRoot.querySelectorAll(selector).forEach(element => {
            const container = findAttachmentContainer(element, searchRoot);
            if (container?.isConnected && !container.querySelector('textarea')) set.add(container);
          });
        });
      });

      searchRoots.forEach(searchRoot => {
        searchRoot.querySelectorAll('div, li, article, section').forEach(element => {
          if (!(element instanceof HTMLElement) || !isElementVisible(element)) return;
          if (element === searchRoot) return;
          if (element.querySelector('textarea')) return;

          const text = getElementText(element);
          if (!text || text.length > DOM_TUNING.ATTACHMENT_TEXT_MAX_LENGTH) return;
          if (!ATTACHMENT_NAME_RE.test(text) || !ATTACHMENT_SIZE_RE.test(text)) return;
          if (extractDetectedFileNames([text]).size > 1) return;
          if (!hasNestedAttachmentLikeChild(element)) set.add(element);
        });
      });

      return Array.from(set);
    });
  }

  function getComposerActionButtons(root, textarea) {
    return getVisibleControls(root).filter(control => {
      if (!isElementAfter(textarea, control)) return false;
      const label = getControlLabel(control);
      return !SEARCH_EXCLUSION_KEYWORD_RE.test(label);
    });
  }

  function isSameVisualRow(first, second, tolerance = DOM_TUNING.GENERIC_TEXTAREA_ROW_TOLERANCE) {
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) return false;
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const firstCenter = firstRect.top + firstRect.height / 2;
    const secondCenter = secondRect.top + secondRect.height / 2;
    return Math.abs(firstCenter - secondCenter) <= tolerance;
  }

  function getNearestSharedContainer(first, second, fallbackRoot) {
    let node = first instanceof HTMLElement ? first.parentElement : null;
    while (node && node !== document.body) {
      if (node.contains(second)) {
        const controls = getVisibleControls(node);
        if (
          controls.length >= DOM_TUNING.SHARED_CONTAINER_MIN_CONTROLS &&
          controls.length <= DOM_TUNING.SHARED_CONTAINER_MAX_CONTROLS
        ) return node;
      }
      node = node.parentElement;
    }
    return fallbackRoot;
  }

  function scoreComposerRoot(candidate, textarea) {
    if (!(candidate instanceof HTMLElement) || !candidate.contains(textarea) || !isElementVisible(candidate)) {
      return Number.NEGATIVE_INFINITY;
    }

    const rect = candidate.getBoundingClientRect();
    const text = getElementText(candidate).toLowerCase();
    const controls = getVisibleControls(candidate);
    const actionButtons = getComposerActionButtons(candidate, textarea);
    const attachments = collectAttachmentElements(candidate);
    return scoreComposerRootFeatures({
      isForm: candidate.matches('form'),
      controlsCount: controls.length,
      actionButtonsCount: actionButtons.length,
      attachmentsCount: attachments.length,
      ancestorDistance: getAncestorDistance(textarea, candidate),
      hasTextHint: /深度思考|智能搜索|deepseek|消息|message/.test(text),
      width: rect.width,
      height: rect.height,
      viewportHeight: window.innerHeight,
      childElementCount: candidate.childElementCount
    });
  }

  function findComposerTextarea() {
    return getCachedDomValue('composerTextarea', () => {
      const textareas = Array.from(document.querySelectorAll('textarea')).filter(isElementVisible);
      return textareas.find(textarea => {
        const hint = [
          textarea.getAttribute('placeholder'),
          textarea.getAttribute('aria-label')
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return /deepseek|message|消息|输入|chat/.test(hint);
      }) || textareas[0] || document.querySelector('textarea');
    });
  }

  function findUploadInput() {
    return getCachedDomValue('uploadInput', () => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input => !input.disabled);
      if (!inputs.length) return null;

      const textarea = findComposerTextarea();
      const localRoots = textarea ? [
        textarea.closest('form'),
        textarea.parentElement,
        textarea.parentElement?.parentElement
      ].filter((root, index, list) => root instanceof HTMLElement && list.indexOf(root) === index) : [];

      const scoreInput = input => {
        let score = 0;
        if (input.multiple) score += UPLOAD_INPUT_SCORE.MULTIPLE;
        if (input.hidden || input.style.display === 'none') score += UPLOAD_INPUT_SCORE.HIDDEN;
        if (input.accept) score += UPLOAD_INPUT_SCORE.ACCEPT;

        if (textarea instanceof HTMLElement) {
          if (localRoots.some(root => root.contains(input))) score += UPLOAD_INPUT_SCORE.INSIDE_LOCAL_ROOT;
          if (input.closest('form') && input.closest('form') === textarea.closest('form')) score += UPLOAD_INPUT_SCORE.SAME_FORM_AS_TEXTAREA;
        }

        return score;
      };

      return inputs
        .map(input => ({ input, score: scoreInput(input) }))
        .sort((left, right) => right.score - left.score)[0]?.input || null;
    });
  }

  function getComposerForm() {
    return getCachedDomValue('composerForm', () => {
      const textarea = findComposerTextarea();
      if (textarea?.closest('form')) return textarea.closest('form');
      const input = findUploadInput();
      return input?.closest('form') || null;
    });
  }

  function findComposerRoot() {
    return getCachedDomValue('composerRoot', () => {
      const textarea = findComposerTextarea();
      if (textarea) {
        let node = textarea.parentElement;
        let best = textarea.parentElement || textarea;
        let bestScore = Number.NEGATIVE_INFINITY;

        while (node && node !== document.body) {
          const score = scoreComposerRoot(node, textarea);
          if (score > bestScore) {
            bestScore = score;
            best = node;
          }
          node = node.parentElement;
        }

        if (best) return best;
      }

      const input = findUploadInput();
      if (input) return input.closest('form') || input.parentElement || document.body;
      return document.body;
    });
  }

  function isControlDisabled(control) {
    if (!control) return true;
    return Boolean(
      ('disabled' in control && control.disabled) ||
      control.getAttribute('aria-disabled') === 'true' ||
      control.getAttribute('data-disabled') === 'true'
    );
  }

  function scoreSendControl(control, root, composerForm, composerRoot, textarea, composerActionButtons) {
    if (!(control instanceof HTMLElement) || !isElementVisible(control)) return Number.NEGATIVE_INFINITY;
    if (ui.wrapper?.contains(control)) return Number.NEGATIVE_INFINITY;

    const label = getControlLabel(control);
    return scoreSendControlFeatures({
      isStopOnlyControl: STOP_KEYWORD_RE.test(label) && !SEND_KEYWORD_RE.test(label),
      isUploadOnlyControl: UPLOAD_KEYWORD_RE.test(label) && !SEND_KEYWORD_RE.test(label),
      matchesTestId: control.matches('[data-testid*="send" i]'),
      hasExplicitSendLabel: control.matches('[aria-label*="send" i], [aria-label*="发送"], [title*="send" i], [title*="发送"]'),
      isSubmitControl: control.matches('button[type="submit"], input[type="submit"]'),
      hasSendKeyword: SEND_KEYWORD_RE.test(label),
      hasIconHint: /arrow-up|paper-plane|enter|submit/.test(label),
      hasSearchExclusion: SEARCH_EXCLUSION_KEYWORD_RE.test(label),
      isSameForm: Boolean(composerForm && control.closest('form') === composerForm),
      isInsideComposer: Boolean(composerRoot && composerRoot.contains(control)),
      rootKind: root === composerForm ? 'form' : (root === composerRoot ? 'composer' : 'other'),
      isAfterTextarea: Boolean(textarea && isElementAfter(textarea, control)),
      isBeforeTextarea: Boolean(textarea && !isElementAfter(textarea, control)),
      isActionButton: composerActionButtons.includes(control),
      isLastActionButton: composerActionButtons.includes(control) && control === composerActionButtons[composerActionButtons.length - 1],
      isFirstActionButton: composerActionButtons.length > 1 && control === composerActionButtons[0],
      isDisabled: isControlDisabled(control)
    });
  }

  function findSendButton() {
    return getCachedDomValue('sendButton', () => {
      const textarea = findComposerTextarea();
      const composerForm = getComposerForm();
      const composerRoot = findComposerRoot();
      const composerActionButtons = textarea ? getComposerActionButtons(composerRoot, textarea) : [];
      const roots = [composerForm, composerRoot, document.body].filter((root, index, list) => root && list.indexOf(root) === index);
      const seen = new Set();
      let bestControl = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      roots.forEach(root => {
        root.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(control => {
          if (seen.has(control)) return;
          seen.add(control);
          const score = scoreSendControl(control, root, composerForm, composerRoot, textarea, composerActionButtons);
          if (score > bestScore) {
            bestScore = score;
            bestControl = control;
          }
        });
      });

      const fallbackButtons = composerActionButtons.filter(control => {
        const label = getControlLabel(control);
        return !UPLOAD_KEYWORD_RE.test(label) && !STOP_KEYWORD_RE.test(label) && !SEARCH_EXCLUSION_KEYWORD_RE.test(label);
      });

      if (
        (!bestControl || bestScore <= SEND_SCORE.MIN_ACCEPTED_SCORE) &&
        fallbackButtons.length &&
        composerActionButtons.length >= SEND_SCORE.MIN_FALLBACK_ACTION_BUTTONS
      ) {
        return fallbackButtons[fallbackButtons.length - 1];
      }

      return bestScore > SEND_SCORE.MIN_ACCEPTED_SCORE ? bestControl : null;
    });
  }

  function isSendButtonAvailable() {
    const sendBtn = findSendButton();
    return Boolean(sendBtn && !isControlDisabled(sendBtn));
  }

  function findStopButton() {
    return getCachedDomValue('stopButton', () => {
      const textarea = findComposerTextarea();
      const composerRoot = findComposerRoot();
      const sendButton = findSendButton();
      const localContainer = textarea instanceof HTMLElement
        ? (sendButton instanceof HTMLElement
          ? getNearestSharedContainer(textarea, sendButton, composerRoot)
          : (textarea.parentElement || composerRoot))
        : composerRoot;
      const composerActionButtons = textarea ? getComposerActionButtons(composerRoot, textarea) : [];
      const roots = [localContainer, composerRoot].filter((root, index, list) => (
        root instanceof HTMLElement && list.indexOf(root) === index
      ));

      for (const root of roots) {
        const controls = getVisibleControls(root);
        for (const control of controls) {
          const label = getControlLabel(control);
          if (!STOP_KEYWORD_RE.test(label)) continue;
          if (UPLOAD_KEYWORD_RE.test(label)) continue;
          const explicitStopLabel = EXPLICIT_STOP_KEYWORD_RE.test(label);
          const isLikelyComposerControl = composerActionButtons.includes(control) || (
            textarea instanceof HTMLElement &&
            localContainer instanceof HTMLElement &&
            localContainer.contains(control) &&
            isElementAfter(textarea, control)
          );
          if (!explicitStopLabel && !isLikelyComposerControl) continue;
          return control;
        }
      }

      return null;
    });
  }

  function isAssistantResponding() {
    return Boolean(findStopButton());
  }

  function findNativeUploadButton() {
    return getCachedDomValue('nativeUploadButton', () => {
      const textarea = findComposerTextarea();
      const composerRoot = findComposerRoot();
      if (!(textarea instanceof HTMLElement) || !(composerRoot instanceof HTMLElement)) return null;

      const attachments = collectAttachmentElements(composerRoot);
      const sendButton = findSendButton();
      const localContainer = sendButton instanceof HTMLElement
        ? getNearestSharedContainer(textarea, sendButton, composerRoot)
        : (textarea.parentElement || composerRoot);
      const roots = [localContainer, textarea.parentElement, composerRoot].filter((root, index, list) => (
        root instanceof HTMLElement && list.indexOf(root) === index
      ));

      let best = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      roots.forEach(root => {
        getVisibleControls(root).forEach(control => {
          if (control === ui.btn || ui.wrapper?.contains(control)) return;
          if (attachments.some(item => item.contains(control))) return;

          const label = getControlLabel(control);
          if (SEARCH_EXCLUSION_KEYWORD_RE.test(label) || /删除|remove|close|关闭/.test(label)) return;

          const rect = control.getBoundingClientRect();
          const textareaRect = textarea.getBoundingClientRect();
          const centerOffset = Math.abs((rect.top + rect.height / 2) - (textareaRect.top + textareaRect.height / 2));
          const afterTextarea = isElementAfter(textarea, control);
          const beforeTextarea = isElementAfter(control, textarea);
          const gapToSend = sendButton instanceof HTMLElement
            ? Math.abs(sendButton.getBoundingClientRect().left - rect.right)
            : Number.POSITIVE_INFINITY;

          const score = scoreUploadAnchorFeatures({
            isAfterTextarea: afterTextarea,
            isBeforeTextarea: beforeTextarea,
            isSameRow: isSameVisualRow(textarea, control, DOM_TUNING.LOCAL_COMPOSER_ROW_TOLERANCE),
            isCenterOffsetClose: centerOffset <= DOM_TUNING.NATIVE_UPLOAD_CLOSE_CENTER_OFFSET,
            isRightOfTextarea: rect.left >= textareaRect.right - UI_PLACEMENT.GAP,
            isAfterSendButton: Boolean(sendButton instanceof HTMLElement && control !== sendButton && isElementAfter(control, sendButton)),
            isSameParentAsSend: Boolean(sendButton instanceof HTMLElement && control.parentElement === sendButton.parentElement),
            isLocalContainer: root === localContainer,
            isTextareaParent: control.parentElement === textarea.parentElement,
            hasEmptyLabel: !label,
            hasUploadKeyword: UPLOAD_KEYWORD_RE.test(label),
            isSendButton: Boolean(sendButton instanceof HTMLElement && control === sendButton),
            hasTightGapToSend: gapToSend <= DOM_TUNING.NATIVE_UPLOAD_SEND_GAP_TIGHT,
            hasLooseGapToSend: gapToSend > DOM_TUNING.NATIVE_UPLOAD_SEND_GAP_TIGHT && gapToSend <= DOM_TUNING.NATIVE_UPLOAD_SEND_GAP_LOOSE,
            isNearTextareaLeftEdge: rect.right <= textareaRect.left + DOM_TUNING.NATIVE_UPLOAD_NEAR_LEFT_EDGE_OFFSET
          });

          if (score > bestScore) {
            bestScore = score;
            best = control;
          }
        });
      });

      return bestScore >= UPLOAD_ANCHOR_SCORE.MIN_ACCEPTED_SCORE ? best : null;
    });
  }

  function clearPlacementTimer() {
    if (ui.placementTimerId) {
      clearTimeout(ui.placementTimerId);
      ui.placementTimerId = null;
    }
  }

  function syncUIPlacement() {
    if (!ui.wrapper) return;

    const anchor = findNativeUploadButton();
    ui.wrapper.classList.remove('is-floating', 'is-anchored', 'drawer-right');

    if (anchor instanceof HTMLElement && isElementVisible(anchor)) {
      const rect = anchor.getBoundingClientRect();
      const buttonSize = UI_PLACEMENT.BUTTON_SIZE;
      const gap = UI_PLACEMENT.GAP;
      const minLeft = UI_PLACEMENT.VIEWPORT_MARGIN;
      const maxLeft = Math.max(minLeft, window.innerWidth - buttonSize - UI_PLACEMENT.VIEWPORT_MARGIN);
      const maxTop = Math.max(UI_PLACEMENT.VIEWPORT_MARGIN, window.innerHeight - buttonSize - UI_PLACEMENT.VIEWPORT_MARGIN);
      const leftCandidate = rect.left - buttonSize - gap;
      const rightCandidate = rect.right + gap;
      const preferredLeft = leftCandidate >= minLeft
        ? leftCandidate
        : (rightCandidate <= maxLeft ? rightCandidate : leftCandidate);
      const left = Math.min(maxLeft, Math.max(minLeft, preferredLeft));
      const top = Math.min(maxTop, Math.max(UI_PLACEMENT.VIEWPORT_MARGIN, rect.top + (rect.height - buttonSize) / 2));

      ui.wrapper.classList.add('is-anchored');
      ui.wrapper.classList.toggle('drawer-right', left + 340 > window.innerWidth - 12);
      ui.wrapper.style.left = `${left}px`;
      ui.wrapper.style.top = `${top}px`;
      ui.wrapper.style.right = '';
      ui.wrapper.style.bottom = '';
      return;
    }

    ui.wrapper.classList.add('is-floating', 'drawer-right');
    ui.wrapper.style.left = '';
    ui.wrapper.style.top = '';
    ui.wrapper.style.right = window.innerWidth <= 560 ? '12px' : '20px';
    ui.wrapper.style.bottom = window.innerWidth <= 560 ? '96px' : '120px';
  }

  function schedulePlacementSync(delay = 60) {
    clearPlacementTimer();
    ui.placementTimerId = setTimeout(() => {
      ui.placementTimerId = null;
      syncUIPlacement();
    }, delay);
  }

  function observePlacement() {
    if (ui.placementObserver) return;

    ui.placementObserver = new MutationObserver(mutations => {
      scheduleDomCacheInvalidation();
      const relevant = mutations.some(mutation => !ui.wrapper?.contains(mutation.target));
      if (!relevant) return;
      schedulePlacementSync();
    });

    ui.placementObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-disabled', 'disabled']
    });

    window.addEventListener('resize', () => schedulePlacementSync(), { passive: true });
    document.addEventListener('scroll', () => schedulePlacementSync(20), true);
  }

  function getComposerWatchRoots(includeBody = true) {
    const roots = [
      findComposerRoot(),
      getComposerForm(),
      findComposerTextarea(),
      findUploadInput(),
      includeBody ? document.body : null
    ];

    return roots.filter((root, index, list) => (
      root instanceof HTMLElement && list.indexOf(root) === index
    ));
  }

  function observeComposerSignals(onChange, options = {}) {
    let disposed = false;
    let scheduled = false;
    const listeners = [];
    const includeBody = options.includeBody !== false;
    const includeTextarea = options.includeTextarea !== false;
    const includeUploadInput = options.includeUploadInput !== false;
    const roots = getComposerWatchRoots(includeBody);

    const schedule = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!disposed) onChange();
      });
    };

    const observer = new MutationObserver(() => {
      scheduleDomCacheInvalidation();
      schedule();
    });

    roots.forEach(root => {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-disabled', 'disabled', 'hidden']
      });
    });

    const bind = (target, type) => {
      if (!(target instanceof EventTarget)) return;
      target.addEventListener(type, schedule, true);
      listeners.push([target, type]);
    };

    if (includeTextarea) {
      const textarea = findComposerTextarea();
      bind(textarea, 'input');
      bind(textarea, 'change');
    }

    if (includeUploadInput) {
      const input = findUploadInput();
      bind(input, 'input');
      bind(input, 'change');
    }

    return () => {
      disposed = true;
      observer.disconnect();
      listeners.forEach(([target, type]) => {
        target.removeEventListener(type, schedule, true);
      });
    };
  }

  function getAttachmentCount(root = document) {
    return collectAttachmentElements(root).length;
  }

  function getComposerAttachmentCount() {
    return getAttachmentCount(findComposerRoot());
  }

  function getUploadInputFileCount() {
    const input = findUploadInput();
    return input?.files?.length || 0;
  }

  function inspectBatchAttachmentState(batchItems, root = findComposerRoot()) {
    const emptyState = {
      matchedNames: 0,
      visibleAttachments: 0,
      failedAttachments: 0,
      failedNames: [],
      hasServerBusyError: false,
      hasDuplicateBatchNames: false,
      inputFileCount: getUploadInputFileCount()
    };
    if (!Array.isArray(batchItems) || !batchItems.length || !(root instanceof HTMLElement)) return emptyState;

    const attachmentElements = collectAttachmentElements(root);
    const texts = [
      getElementText(root),
      ...attachmentElements.map(getElementText)
    ]
      .map(normalizeSearchText)
      .filter(Boolean);

    if (!texts.length) {
      return {
        ...emptyState,
        visibleAttachments: attachmentElements.length
      };
    }

    const detectedNames = extractDetectedFileNames(texts);
    const combinedText = texts.join('\n');
    const normalizedBatchNames = batchItems
      .map(item => normalizeSearchText(item?.name))
      .filter(Boolean);
    const uniqueBatchNames = Array.from(new Set(normalizedBatchNames));
    const matchedNames = uniqueBatchNames.reduce((count, fileName) => {
      if (detectedNames.has(fileName)) return count + 1;
      return combinedText.includes(fileName) ? count + 1 : count;
    }, 0);
    const hasDuplicateBatchNames = uniqueBatchNames.length !== normalizedBatchNames.length;

    const failedNames = new Set();
    let hasServerBusyError = false;
    const namesToStrip = Array.from(new Set([...uniqueBatchNames, ...detectedNames]));
    attachmentElements.forEach(element => {
      const text = normalizeSearchText(getElementText(element));
      const statusText = stripKnownFileNames(text, namesToStrip);
      if (!statusText || !ATTACHMENT_ERROR_RE.test(statusText)) return;
      if (ATTACHMENT_SERVER_BUSY_RE.test(statusText)) hasServerBusyError = true;

      const matchedFileName = uniqueBatchNames.find(fileName => text.includes(fileName));
      if (matchedFileName) {
        failedNames.add(matchedFileName);
        return;
      }

      failedNames.add('__generic__');
    });

    return {
      matchedNames,
      visibleAttachments: attachmentElements.length,
      failedAttachments: failedNames.size,
      failedNames: Array.from(failedNames).filter(name => name !== '__generic__'),
      hasServerBusyError,
      hasDuplicateBatchNames,
      inputFileCount: getUploadInputFileCount()
    };
  }

  function countMatchedBatchFileNames(batchItems, root = findComposerRoot()) {
    return inspectBatchAttachmentState(batchItems, root).matchedNames;
  }

  function hasAttachmentErrorIndicators(root = findComposerRoot()) {
    if (!(root instanceof HTMLElement)) return false;
    return collectAttachmentElements(root).some(element => {
      const text = normalizeSearchText(getElementText(element));
      const namesToStrip = Array.from(extractDetectedFileNames([text]));
      const statusText = stripKnownFileNames(text, namesToStrip);
      return Boolean(statusText && ATTACHMENT_ERROR_RE.test(statusText));
    });
  }

  shared.syncUIPlacement = syncUIPlacement;
  shared.getComposerAttachmentCount = getComposerAttachmentCount;

  Object.assign(shared, {
    isElementVisible,
    getControlLabel,
    getElementText,
    normalizeSearchText,
    cleanDetectedFileName,
    escapeRegExp,
    stripKnownFileNames,
    extractDetectedFileNames,
    isElementAfter,
    getVisibleControls,
    findAttachmentContainer,
    collectAttachmentElements,
    getComposerActionButtons,
    isSameVisualRow,
    getNearestSharedContainer,
    scoreComposerRootFeatures,
    scoreComposerRoot,
    scoreSendControlFeatures,
    findUploadInput,
    findComposerTextarea,
    getComposerForm,
    findComposerRoot,
    isControlDisabled,
    scoreSendControl,
    findSendButton,
    isSendButtonAvailable,
    findStopButton,
    isAssistantResponding,
    scoreUploadAnchorFeatures,
    findNativeUploadButton,
    clearPlacementTimer,
    syncUIPlacement,
    schedulePlacementSync,
    observePlacement,
    getComposerWatchRoots,
    observeComposerSignals,
    getAttachmentCount,
    getComposerAttachmentCount,
    getUploadInputFileCount,
    inspectBatchAttachmentState,
    countMatchedBatchFileNames,
    hasAttachmentErrorIndicators
  });

  shared.__dfsHeuristics = {
    scoreComposerRootFeatures,
    scoreSendControlFeatures,
    scoreUploadAnchorFeatures
  };
})();
