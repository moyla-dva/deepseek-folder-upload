import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSharedRuntime() {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: callback => callback(),
    cancelAnimationFrame: () => {},
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    HTMLElement: class HTMLElement {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    Event: class Event {},
    InputEvent: class InputEvent {},
    document: {
      body: {},
      querySelectorAll() { return []; },
      querySelector() { return null; }
    }
  };

  context.window = context;
  context.window.innerHeight = 1000;
  context.window.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1'
  });

  vm.createContext(context);

  for (const fileName of ['dfs-core.js', 'dfs-dom-adapter.js']) {
    const source = fs.readFileSync(path.join(ROOT_DIR, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  }

  const shared = context.window.__dfsShared;
  shared.__testContext = context;
  return shared;
}

function createMockElement(shared, options = {}) {
  const { HTMLElement } = shared.__testContext;
  const element = new HTMLElement();
  const attrs = { ...(options.attrs || {}) };
  const tagName = String(options.tag || 'div').toUpperCase();
  const rect = {
    top: options.rect?.top || 0,
    left: options.rect?.left || 0,
    width: options.rect?.width || 320,
    height: options.rect?.height || 40
  };
  rect.right = rect.left + rect.width;
  rect.bottom = rect.top + rect.height;

  let ownText = String(options.text || '');
  element.tagName = tagName;
  element.children = [];
  element.parentElement = null;
  element.style = {};
  element.hidden = false;
  element.disabled = Boolean(options.disabled);
  element.readOnly = Boolean(options.readOnly);
  element.isConnected = true;

  Object.defineProperty(element, 'textContent', {
    get() {
      const childText = element.children.map(child => String(child.textContent || '')).join(' ');
      return [ownText, childText].filter(Boolean).join(' ').trim();
    },
    set(value) {
      ownText = String(value || '');
    }
  });

  element.getAttribute = name => Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
  element.setAttribute = (name, value) => {
    attrs[name] = String(value);
  };
  element.matches = selector => matchesSelector(element, selector);
  element.closest = selector => {
    let node = element;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  };
  element.contains = target => {
    if (!target) return false;
    if (target === element) return true;
    return element.children.some(child => child.contains && child.contains(target));
  };
  element.appendChild = child => {
    child.parentElement = element;
    element.children.push(child);
    return child;
  };
  element.querySelectorAll = selector => querySelectorAllFrom(element, selector);
  element.querySelector = selector => element.querySelectorAll(selector)[0] || null;
  element.getBoundingClientRect = () => ({ ...rect });
  element.getClientRects = () => (options.visible === false ? [] : [{ ...rect }]);

  (options.children || []).forEach(child => {
    element.appendChild(child);
  });

  return element;
}

function matchesSelector(element, selector) {
  const trimmed = String(selector || '').trim();
  if (!trimmed) return false;

  const selectorMatch = trimmed.match(/^([a-z]+)?((?:\[[^\]]+\])*)$/i);
  if (!selectorMatch) return false;

  const [, rawTagName = '', rawAttributes = ''] = selectorMatch;
  if (rawTagName && element.tagName.toLowerCase() !== rawTagName.toLowerCase()) return false;

  const attributeMatches = Array.from(rawAttributes.matchAll(/\[([^\]=*]+)(\*?=)"([^"]+)"(?:\s+i)?\]/gi));
  return attributeMatches.every(([, attrName, operator, expectedValue]) => {
    const actualValue = String(element.getAttribute(attrName) || '');
    if (operator === '=') return actualValue === expectedValue;
    if (operator === '*=') return actualValue.toLowerCase().includes(expectedValue.toLowerCase());
    return false;
  });
}

function querySelectorAllFrom(root, selector) {
  const selectors = String(selector || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const results = [];

  const visit = node => {
    node.children.forEach(child => {
      if (selectors.some(item => matchesSelector(child, item))) {
        results.push(child);
      }
      visit(child);
    });
  };

  visit(root);
  return results;
}

test('multilingual keyword groups remain available to DOM adapter', () => {
  const shared = loadSharedRuntime();

  assert.equal(shared.SEND_KEYWORD_RE.test('Enviar mensaje'), true);
  assert.equal(shared.STOP_KEYWORD_RE.test('Abbrechen'), true);
  assert.equal(shared.UPLOAD_KEYWORD_RE.test('添付ファイル'), true);
  assert.equal(shared.SEARCH_EXCLUSION_KEYWORD_RE.test('Buscar en la web'), true);
});

test('send control scoring prefers real send buttons over upload or stop controls', () => {
  const shared = loadSharedRuntime();
  const { scoreSendControlFeatures } = shared.__dfsHeuristics;

  const sendScore = scoreSendControlFeatures({
    isStopOnlyControl: false,
    isUploadOnlyControl: false,
    matchesTestId: true,
    hasExplicitSendLabel: true,
    isSubmitControl: true,
    hasSendKeyword: true,
    hasIconHint: true,
    hasSearchExclusion: false,
    isSameForm: true,
    isInsideComposer: true,
    rootKind: 'form',
    isAfterTextarea: true,
    isBeforeTextarea: false,
    isActionButton: true,
    isLastActionButton: true,
    isFirstActionButton: false,
    isDisabled: false
  });

  const uploadOnlyScore = scoreSendControlFeatures({
    isStopOnlyControl: false,
    isUploadOnlyControl: true
  });

  const stopOnlyScore = scoreSendControlFeatures({
    isStopOnlyControl: true,
    isUploadOnlyControl: false
  });

  assert.equal(uploadOnlyScore, Number.NEGATIVE_INFINITY);
  assert.equal(stopOnlyScore, Number.NEGATIVE_INFINITY);
  assert.ok(sendScore > 20);
});

test('composer root scoring favors the actual composer over oversized wrappers', () => {
  const shared = loadSharedRuntime();
  const { scoreComposerRootFeatures } = shared.__dfsHeuristics;

  const focusedComposerScore = scoreComposerRootFeatures({
    isForm: true,
    controlsCount: 5,
    actionButtonsCount: 2,
    attachmentsCount: 1,
    hasTextHint: true,
    width: 720,
    height: 180,
    viewportHeight: 1000,
    childElementCount: 10
  });

  const oversizedWrapperScore = scoreComposerRootFeatures({
    isForm: false,
    controlsCount: 1,
    actionButtonsCount: 0,
    attachmentsCount: 0,
    hasTextHint: false,
    width: 1000,
    height: 820,
    viewportHeight: 1000,
    childElementCount: 60
  });

  assert.ok(focusedComposerScore > oversizedWrapperScore);
});

test('composer root scoring favors nearby composer containers over distant attachment-heavy wrappers', () => {
  const shared = loadSharedRuntime();
  const { scoreComposerRootFeatures } = shared.__dfsHeuristics;

  const nearbyComposerScore = scoreComposerRootFeatures({
    isForm: true,
    controlsCount: 5,
    actionButtonsCount: 2,
    attachmentsCount: 2,
    ancestorDistance: 2,
    hasTextHint: true,
    width: 720,
    height: 180,
    viewportHeight: 1000,
    childElementCount: 12
  });

  const distantWrapperScore = scoreComposerRootFeatures({
    isForm: false,
    controlsCount: 5,
    actionButtonsCount: 2,
    attachmentsCount: 135,
    ancestorDistance: 8,
    hasTextHint: true,
    width: 1100,
    height: 760,
    viewportHeight: 1000,
    childElementCount: 70
  });

  assert.ok(nearbyComposerScore > distantWrapperScore);
});

test('attachment collection stays scoped to the local composer instead of counting historical message attachments', () => {
  const shared = loadSharedRuntime();
  const { document } = shared.__testContext;

  const historyAttachmentA = createMockElement(shared, {
    tag: 'div',
    text: 'history-a.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const historyAttachmentB = createMockElement(shared, {
    tag: 'div',
    text: 'history-b.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const localAttachmentA = createMockElement(shared, {
    tag: 'div',
    text: 'current-a.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const localAttachmentB = createMockElement(shared, {
    tag: 'div',
    text: 'current-b.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const composerAttachments = createMockElement(shared, {
    tag: 'div',
    children: [localAttachmentA, localAttachmentB]
  });
  const textarea = createMockElement(shared, {
    tag: 'textarea',
    attrs: { placeholder: '给 DeepSeek 发送消息' }
  });
  const composerForm = createMockElement(shared, {
    tag: 'form',
    children: [composerAttachments, textarea]
  });
  const historySection = createMockElement(shared, {
    tag: 'section',
    children: [historyAttachmentA, historyAttachmentB]
  });
  const chatWrapper = createMockElement(shared, {
    tag: 'section',
    children: [historySection, composerForm]
  });

  document.body = chatWrapper;
  document.querySelectorAll = selector => chatWrapper.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  shared.invalidateDomCache();

  const attachments = shared.collectAttachmentElements(chatWrapper);
  assert.equal(attachments.length, 2);
  assert.deepEqual(
    Array.from(attachments, item => item.textContent),
    ['current-a.txt 35B', 'current-b.txt 35B']
  );
});

test('attachment collection still sees official composer attachments when the composer root is narrower than the form', () => {
  const shared = loadSharedRuntime();
  const { document } = shared.__testContext;

  const historyAttachment = createMockElement(shared, {
    tag: 'div',
    text: 'history-only.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const officialAttachment = createMockElement(shared, {
    tag: 'div',
    text: 'official-upload.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const officialAttachmentRow = createMockElement(shared, {
    tag: 'div',
    children: [officialAttachment]
  });
  const textarea = createMockElement(shared, {
    tag: 'textarea',
    attrs: { placeholder: '给 DeepSeek 发送消息' }
  });
  const textareaRow = createMockElement(shared, {
    tag: 'div',
    children: [textarea]
  });
  const composerForm = createMockElement(shared, {
    tag: 'form',
    children: [officialAttachmentRow, textareaRow]
  });
  const historySection = createMockElement(shared, {
    tag: 'section',
    children: [historyAttachment]
  });
  const chatWrapper = createMockElement(shared, {
    tag: 'section',
    children: [historySection, composerForm]
  });

  document.body = chatWrapper;
  document.querySelectorAll = selector => chatWrapper.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  shared.invalidateDomCache();

  const attachments = shared.collectAttachmentElements(textareaRow);
  assert.equal(attachments.length, 1);
  assert.deepEqual(
    Array.from(attachments, item => item.textContent),
    ['official-upload.txt 35B']
  );
});

test('scheduled DOM cache invalidation coalesces repeated resets into one microtask', async () => {
  const shared = loadSharedRuntime();
  const startVersion = shared.domCache.version;

  shared.scheduleDomCacheInvalidation();
  shared.scheduleDomCacheInvalidation();

  assert.equal(shared.domCache.version, startVersion);
  await Promise.resolve();
  assert.equal(shared.domCache.version, startVersion + 1);

  shared.scheduleDomCacheInvalidation();
  await Promise.resolve();
  assert.equal(shared.domCache.version, startVersion + 2);
});

test('duplicate batch file names do not get double-counted as matched attachments', () => {
  const shared = loadSharedRuntime();
  const { document } = shared.__testContext;

  const attachment = createMockElement(shared, {
    tag: 'div',
    text: 'dup.txt 35B',
    attrs: { class: 'file-chip' }
  });
  const attachmentRow = createMockElement(shared, {
    tag: 'div',
    children: [attachment]
  });
  const textarea = createMockElement(shared, {
    tag: 'textarea',
    attrs: { placeholder: '给 DeepSeek 发送消息' }
  });
  const composerForm = createMockElement(shared, {
    tag: 'form',
    children: [attachmentRow, textarea]
  });

  document.body = composerForm;
  document.querySelectorAll = selector => composerForm.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  shared.invalidateDomCache();

  const attachmentState = shared.inspectBatchAttachmentState([
    { name: 'dup.txt' },
    { name: 'dup.txt' }
  ], composerForm);

  assert.equal(attachmentState.matchedNames, 1);
  assert.equal(attachmentState.hasDuplicateBatchNames, true);
});

test('upload anchor scoring favors the companion upload button near the send button', () => {
  const shared = loadSharedRuntime();
  const { scoreUploadAnchorFeatures } = shared.__dfsHeuristics;

  const idealUploadAnchorScore = scoreUploadAnchorFeatures({
    isAfterTextarea: true,
    isBeforeTextarea: false,
    isSameRow: true,
    isCenterOffsetClose: true,
    isRightOfTextarea: true,
    isAfterSendButton: true,
    isSameParentAsSend: true,
    isLocalContainer: true,
    isTextareaParent: true,
    hasEmptyLabel: false,
    hasUploadKeyword: true,
    isSendButton: false,
    hasTightGapToSend: true,
    hasLooseGapToSend: false,
    isNearTextareaLeftEdge: false
  });

  const sendButtonLikeScore = scoreUploadAnchorFeatures({
    isAfterTextarea: true,
    isBeforeTextarea: false,
    isSameRow: true,
    isCenterOffsetClose: true,
    isRightOfTextarea: true,
    isAfterSendButton: false,
    isSameParentAsSend: true,
    isLocalContainer: true,
    isTextareaParent: true,
    hasEmptyLabel: false,
    hasUploadKeyword: false,
    isSendButton: true,
    hasTightGapToSend: false,
    hasLooseGapToSend: false,
    isNearTextareaLeftEdge: false
  });

  assert.ok(idealUploadAnchorScore >= 8);
  assert.ok(idealUploadAnchorScore > sendButtonLikeScore);
});
