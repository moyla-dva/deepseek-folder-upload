import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadWorkflowHelpers() {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: callback => callback(),
    cancelAnimationFrame: () => {},
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    location: {
      pathname: '/',
      search: '',
      hash: ''
    },
    document: {
      body: {},
      querySelectorAll() { return []; },
      querySelector() { return null; }
    },
    HTMLElement: class HTMLElement {},
    Event: class Event {},
    InputEvent: class InputEvent {}
  };

  context.window = context;
  vm.createContext(context);

  const coreSource = fs.readFileSync(path.join(ROOT_DIR, 'dfs-core.js'), 'utf8');
  vm.runInContext(coreSource, context, { filename: 'dfs-core.js' });

  const shared = context.window.__dfsShared;
  shared.updateHeaderChips = () => {};
  shared.updateAll = () => {};
  shared.showDrawer = () => {};
  shared.hideDrawer = () => {};
  shared.findUploadInput = () => null;
  shared.findComposerTextarea = () => null;
  shared.getComposerForm = () => null;
  shared.isElementVisible = () => true;
  shared.findSendButton = () => null;
  shared.isSendButtonAvailable = () => false;
  shared.isControlDisabled = () => false;
  shared.isAssistantResponding = () => false;
  shared.observeComposerSignals = () => () => {};
  shared.getComposerAttachmentCount = () => shared.__composerAttachmentCount || 0;
  shared.getComposerAttachmentNameCounts = () => new Map(shared.__composerAttachmentNameCounts || []);
  shared.inspectBatchAttachmentState = () => ({
    matchedNames: 0,
    visibleAttachments: 0,
    failedAttachments: 0,
    failedNames: [],
    hasServerBusyError: false,
    hasDuplicateBatchNames: false,
    inputFileCount: 0
  });
  shared.hasAttachmentErrorIndicators = () => false;
  shared.isFreshConversationLandingPage = () => Boolean(shared.__landingPage);
  shared.__testLocation = context.location;

  const workflowSource = fs.readFileSync(path.join(ROOT_DIR, 'dfs-workflow.js'), 'utf8');
  vm.runInContext(workflowSource, context, { filename: 'dfs-workflow.js' });

  return shared;
}

test('dynamic batch cooldown adds per-file backoff on top of base cooldown', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  assert.equal(helpers.getBatchCooldownMs(50), 10000);

  shared.state.config.batchInterval = 8;
  assert.equal(helpers.getBatchCooldownMs(50), 13000);
});

test('server busy errors use the longer retry ladder', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  assert.equal(helpers.getAttachmentRetryDelayMs({ serverBusy: true }, 0), 3000);
  assert.equal(helpers.getAttachmentRetryDelayMs({ serverBusy: true }, 1), 6000);
  assert.equal(helpers.getAttachmentRetryDelayMs({ serverBusy: true }, 2), 12000);
  assert.equal(helpers.getAttachmentRetryDelayMs({ serverBusy: false }, 2), 4000);
});

test('existing composer attachments reduce the next injectable batch size', () => {
  const shared = loadWorkflowHelpers();

  shared.state.config.batchSize = 50;

  assert.equal(shared.getInjectableBatchSize(12), 38);
  assert.equal(shared.getInjectableBatchSize(49), 1);
  assert.equal(shared.getInjectableBatchSize(50), 0);
});

test('classifyFiles preserves relative folder paths for later review filtering', () => {
  const shared = loadWorkflowHelpers();

  const { queue } = shared.classifyFiles([
    {
      name: 'report.md',
      webkitRelativePath: 'notes/week-1/report.md',
      size: 42,
      type: 'text/markdown'
    }
  ]);

  assert.equal(queue[0].path, 'notes/week-1/report.md');
});

test('projected total batches account for a smaller first injection when the composer already has attachments', () => {
  const shared = loadWorkflowHelpers();
  const queue = Array.from({ length: 100 }, (_, index) => ({ name: `file-${index}.txt` }));

  shared.state.config.batchSize = 50;
  shared.state.queue = queue.slice();
  shared.getComposerAttachmentCount = () => 12;

  shared.refreshTotalBatches();
  assert.equal(shared.state.totalBatches, 3);

  shared.state.currentBatch = queue.slice(0, 38);
  shared.refreshTotalBatches();
  assert.equal(shared.state.totalBatches, 3);
});

test('current batch planning counts unique composer attachments toward the logical batch even when they appear near the tail of the queue', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.config.batchSize = 50;
  shared.state.queue = Array.from({ length: 51 }, (_, index) => ({
    name: `file-${String(index + 1).padStart(2, '0')}.txt`
  }));
  shared.__composerAttachmentCount = 3;
  shared.__composerAttachmentNameCounts = [
    ['file-49.txt', 1],
    ['file-50.txt', 1],
    ['file-51.txt', 1]
  ];

  const plan = helpers.buildCurrentBatchSelectionPlan({
    existingAttachmentCount: shared.__composerAttachmentCount
  });

  assert.equal(plan.batchItems.length, 50);
  assert.equal(plan.preloadedItems.length, 3);
  assert.equal(plan.injectItems.length, 47);
  assert.equal(plan.preloadedItems.map(item => item.name).join(','), 'file-49.txt,file-50.txt,file-51.txt');
  assert.equal(plan.batchItems.some(item => item.name === 'file-48.txt'), false);
  assert.equal(plan.batchItems[plan.batchItems.length - 1].name, 'file-51.txt');
});

test('current batch planning does not treat duplicate queue names as already covered by composer attachments', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.config.batchSize = 50;
  shared.state.queue = [
    { name: 'dup.txt' },
    { name: 'dup.txt' },
    { name: 'other.txt' }
  ];
  shared.__composerAttachmentCount = 1;
  shared.__composerAttachmentNameCounts = [
    ['dup.txt', 1]
  ];

  const plan = helpers.buildCurrentBatchSelectionPlan({
    existingAttachmentCount: shared.__composerAttachmentCount
  });

  assert.equal(plan.preloadedItems.length, 0);
  assert.equal(plan.injectItems.length, 3);
  assert.equal(plan.batchItems.length, 3);
});

test('folder review arms a delayed auto-start window before uploading begins', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.uploadSource = 'folder';
  shared.state.folderReviewPending = true;
  shared.state.queue = [
    { name: 'alpha.txt' },
    { name: 'beta.txt' }
  ];

  const armed = helpers.beginFolderReview({ autoStartMs: 5000 });

  assert.equal(armed, true);
  assert.equal(shared.state.phase, 'reviewing');
  assert.ok(shared.state.reviewAutoStartAt > Date.now());

  helpers.pauseFolderReviewAutoStart();
  assert.equal(shared.state.reviewAutoStartAt, 0);
});

test('folder review does not re-arm once the first batch has already begun', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.uploadSource = 'folder';
  shared.state.folderReviewPending = true;
  shared.state.completedBatches = 1;
  shared.state.queue = [
    { name: 'tail.txt' }
  ];

  const armed = helpers.beginFolderReview({ autoStartMs: 5000 });

  assert.equal(armed, false);
  assert.notEqual(shared.state.phase, 'reviewing');
});

test('completing folder review clears review mode and query state', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.phase = 'reviewing';
  shared.state.folderReviewPending = true;
  shared.state.reviewMode = 'full';
  shared.state.reviewQuery = 'draft';
  shared.state.removedDuringReviewCount = 3;
  shared.state.queue = [{ name: 'keep.txt' }];

  helpers.completeFolderReview();

  assert.equal(shared.state.folderReviewPending, false);
  assert.equal(shared.state.reviewMode, 'preview');
  assert.equal(shared.state.reviewQuery, '');
  assert.equal(shared.state.removedDuringReviewCount, 0);
  assert.equal(shared.state.phase, 'queued');
});

test('render snapshot reuses composer attachment count across queue summary calculations', () => {
  const shared = loadWorkflowHelpers();
  let reads = 0;

  shared.state.queue = Array.from({ length: 60 }, (_, index) => ({ name: `file-${index}.txt` }));
  shared.getComposerAttachmentCount = () => {
    reads += 1;
    return 12;
  };

  shared.setRenderSnapshot({ composerAttachmentCount: 12 });
  shared.refreshTotalBatches();
  const noticeMarkup = shared.getNoticeMarkup();
  shared.setRenderSnapshot(null);

  assert.equal(reads, 0);
  assert.equal(shared.state.totalBatches, 2);
  assert.match(noticeMarkup, /自动缩到 38 个文件/);
});

test('folder selection enters review mode before the first batch starts', async () => {
  const shared = loadWorkflowHelpers();

  await shared.handleSelectedFiles([
    { name: 'keep-a.txt', size: 10, type: 'text/plain' },
    { name: 'keep-b.txt', size: 20, type: 'text/plain' }
  ], 'folder');

  assert.equal(shared.state.phase, 'reviewing');
  assert.equal(shared.state.currentBatch.length, 0);
  assert.equal(shared.state.queue.length, 2);
  assert.equal(shared.state.reviewMode, 'preview');
  assert.ok(shared.state.reviewAutoStartAt > Date.now());

  shared.clearAllTimers();
});

test('route sync treats the first post-send route change as normal conversation materialization', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.queue = [{ name: 'tail.txt' }];
  shared.state.currentBatch = [{ name: 'alpha.txt' }];
  shared.state.phase = 'sending';
  shared.state.sessionRouteOriginKey = '/';
  shared.__testLocation.pathname = '/chat/abc123';

  const reset = helpers.syncSessionToConversationRoute();

  assert.equal(reset, false);
  assert.equal(shared.state.sessionRouteOriginKey, '/');
  assert.equal(shared.state.sessionEstablishedRouteKey, '/chat/abc123');
  assert.equal(shared.state.currentBatch.length, 1);
});

test('route sync clears pending plugin state after the active conversation route is deleted or changed away', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.queue = [{ name: 'tail.txt' }];
  shared.state.currentBatch = [{ name: 'alpha.txt' }];
  shared.state.phase = 'awaiting_send';
  shared.state.sessionRouteOriginKey = '/';
  shared.state.sessionEstablishedRouteKey = '/chat/abc123';
  shared.__testLocation.pathname = '/';

  const reset = helpers.syncSessionToConversationRoute();

  assert.equal(reset, true);
  assert.equal(shared.state.phase, 'idle');
  assert.equal(shared.state.queue.length, 0);
  assert.equal(shared.state.currentBatch.length, 0);
  assert.equal(shared.state.sessionRouteOriginKey, '/');
  assert.equal(shared.state.sessionEstablishedRouteKey, '');
});

test('route sync clears pending plugin state when the page falls back to the empty landing view on the same route', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.queue = [{ name: 'tail.txt' }];
  shared.state.currentBatch = [{ name: 'alpha.txt' }];
  shared.state.phase = 'awaiting_send';
  shared.state.sessionRouteOriginKey = '/chat/abc123';
  shared.state.sessionEstablishedRouteKey = '/chat/abc123';
  shared.__testLocation.pathname = '/chat/abc123';
  shared.__landingPage = true;

  const reset = helpers.syncSessionToConversationRoute();

  assert.equal(reset, true);
  assert.equal(shared.state.phase, 'idle');
  assert.equal(shared.state.queue.length, 0);
  assert.equal(shared.state.currentBatch.length, 0);
  assert.equal(shared.state.sessionRouteOriginKey, '/chat/abc123');
  assert.equal(shared.state.sessionEstablishedRouteKey, '');
});

test('session log tracks batch lifecycle from injection to completion', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.totalBatches = 3;
  shared.state.currentBatch = [
    { name: 'alpha.txt' },
    { name: 'beta.txt' }
  ];

  const createdEntry = helpers.ensureCurrentBatchLog({ status: 'injecting' });
  assert.equal(createdEntry.batchNumber, 1);
  assert.equal(createdEntry.fileCount, 2);
  assert.equal(createdEntry.status, 'injecting');
  assert.equal(shared.state.sessionLog.length, 1);
  assert.equal(shared.state.currentBatchLogId, createdEntry.id);

  helpers.setCurrentBatchLogStatus('awaiting_send', {
    notes: '附件确认完成，等待发送。'
  });
  assert.equal(shared.state.sessionLog[0].status, 'awaiting_send');
  assert.equal(shared.state.sessionLog[0].notes, '附件确认完成，等待发送。');

  helpers.setCurrentBatchLogStatus('sending', {
    markSentAt: true,
    notes: '插件已自动触发发送。'
  });
  assert.equal(shared.state.sessionLog[0].status, 'sending');
  assert.equal(Boolean(shared.state.sessionLog[0].sentAt), true);

  helpers.finalizeCurrentBatchLog('sent', {
    notes: ''
  });
  assert.equal(shared.state.sessionLog[0].status, 'sent');
  assert.equal(Boolean(shared.state.sessionLog[0].settledAt), true);
  assert.equal(shared.state.currentBatchLogId, '');
});

test('failed-only retry plan promotes failed items and defers the rest', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  const currentBatch = [
    { name: 'alpha.txt' },
    { name: 'beta.txt' },
    { name: 'gamma.txt' },
    { name: 'delta.txt' }
  ];
  const queuedAfter = [
    { name: 'epsilon.txt' }
  ];

  shared.state.totalBatches = 2;
  shared.state.queue = currentBatch.concat(queuedAfter);
  shared.state.currentBatch = currentBatch.slice();

  helpers.ensureCurrentBatchLog({ status: 'failed' });
  helpers.setFailureContext(helpers.buildRetryableFailureContext({
    failedNames: ['beta.txt', 'delta.txt'],
    errorType: 'server_busy'
  }));

  const retryPlan = helpers.prepareFailedItemsRetryContext();
  assert.deepEqual(retryPlan.failedItems.map(item => item.name), ['beta.txt', 'delta.txt']);
  assert.deepEqual(retryPlan.deferredItems.map(item => item.name), ['alpha.txt', 'gamma.txt']);
  assert.deepEqual(shared.state.currentBatch.map(item => item.name), ['beta.txt', 'delta.txt']);
  assert.deepEqual(shared.state.queue.map(item => item.name), ['beta.txt', 'delta.txt', 'alpha.txt', 'gamma.txt', 'epsilon.txt']);
  assert.equal(shared.state.currentBatchLogId, '');
  assert.equal(shared.state.lastFailureContext, null);
  assert.equal(shared.state.sessionLog[0].status, 'failed');
  assert.equal(Boolean(shared.state.sessionLog[0].settledAt), true);
});

test('failed-only retry stays disabled when the batch contains duplicate file names', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.currentBatch = [
    { name: 'dup.txt' },
    { name: 'dup.txt' },
    { name: 'other.txt' }
  ];

  const failureContext = helpers.buildRetryableFailureContext({
    failedNames: ['dup.txt'],
    errorType: 'server_busy'
  });

  assert.equal(failureContext, null);
});

test('error notice explains why failed-only retry stays hidden for duplicate names', () => {
  const shared = loadWorkflowHelpers();

  shared.state.phase = 'error';
  shared.state.errorMessage = '检测到当前批次存在上传失败的附件。';
  shared.state.currentBatch = [
    { name: 'dup.txt' },
    { name: 'dup.txt' },
    { name: 'other.txt' }
  ];

  const noticeMarkup = shared.getNoticeMarkup();

  assert.match(noticeMarkup, /同名文件/);
  assert.match(noticeMarkup, /重试本批/);
});

test('retry current batch keeps failure context while residual attachments still need manual cleanup', async () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.currentBatch = [
    { name: 'alpha.txt' },
    { name: 'beta.txt' }
  ];
  shared.state.currentBatchExpectedAttachments = 2;
  shared.state.currentBatchDetectedAttachments = 1;
  shared.state.currentBatchAttachmentsConfirmed = false;
  shared.state.composerBaselineAttachments = 0;
  shared.__composerAttachmentCount = 1;

  helpers.setFailureContext({
    type: 'failed_items_only',
    failedNames: ['beta.txt'],
    canRetryFailedOnly: true
  });

  await shared.retryCurrentBatch();

  assert.equal(shared.state.phase, 'error');
  assert.equal(shared.state.lastFailureContext?.canRetryFailedOnly, true);
});

test('adaptive batching halves the current session batch size after two server busy failures', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;
  const batchItems = Array.from({ length: 40 }, (_, index) => ({ name: `file-${index}.txt` }));

  shared.state.config.batchSize = 50;
  shared.state.queue = batchItems.slice();
  shared.state.currentBatch = batchItems.slice();
  shared.state.currentBatchExpectedAttachments = batchItems.length;

  const firstFailure = helpers.registerAdaptiveFailure({ serverBusy: true });
  assert.equal(firstFailure.adjusted, false);
  assert.equal(shared.getEffectiveBatchSize(), 50);
  assert.equal(shared.state.currentBatch.length, 40);

  const secondFailure = helpers.registerAdaptiveFailure({ serverBusy: true });
  assert.equal(secondFailure.adjusted, true);
  assert.equal(secondFailure.nextBatchSize, 25);
  assert.equal(secondFailure.splitCurrentBatch, true);
  assert.equal(secondFailure.deferredCount, 15);
  assert.equal(shared.getEffectiveBatchSize(), 25);
  assert.equal(shared.state.currentBatch.length, 25);
  assert.equal(shared.state.queue.length, 40);
});

test('adaptive batching restores toward the configured batch size after two successful batches', () => {
  const shared = loadWorkflowHelpers();
  const helpers = shared.__dfsWorkflowHelpers;

  shared.state.config.batchSize = 50;
  shared.state.sessionBatchSize = 25;

  const firstSuccess = helpers.registerSuccessfulBatch();
  assert.equal(firstSuccess.restored, false);
  assert.equal(shared.getEffectiveBatchSize(), 25);

  const secondSuccess = helpers.registerSuccessfulBatch();
  assert.equal(secondSuccess.restored, true);
  assert.equal(secondSuccess.batchSize, 50);
  assert.equal(shared.state.sessionBatchSize, 0);
  assert.equal(shared.getEffectiveBatchSize(), 50);
});
