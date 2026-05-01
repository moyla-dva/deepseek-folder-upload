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

  return context.window.__dfsShared;
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
