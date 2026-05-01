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

  const workflowSource = fs.readFileSync(path.join(ROOT_DIR, 'dfs-workflow.js'), 'utf8');
  vm.runInContext(workflowSource, context, { filename: 'dfs-workflow.js' });

  return context.window.__dfsShared;
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
