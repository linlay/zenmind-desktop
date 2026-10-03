import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { setMainLocaleForCurrentProcess } = require('../dist-electron/main/support/i18n/main-i18n.js');
const { observeImageGenerateEvent, imageGenerateFailureMessage } = require('../dist-electron/main/modules/agent-platform/image-generation-events.js');
const { ImageCompletion } = require('../dist-electron/main/modules/agent-platform/completion.js');

test('image completion and event errors follow the active locale', async t => {
  t.after(() => setMainLocaleForCurrentProcess('zh-CN'));
  const request = { operation: 'generate', prompt: 'A tree', width: 1024, height: 1024, count: 1, strength: 1, seed: 0 };
  for (const [locale, missing, invalid, toolError] of [
    ['zh-CN', 'Zenmi 未返回 image_generate 工具结果。', 'image_generate 返回了无效结果。', 'Zenmi 图片任务不允许调用 shell。'],
    ['en-US', 'Zenmi did not return an image_generate result.', 'image_generate returned an invalid result.', 'Zenmi image tasks cannot call shell.']
  ]) {
    setMainLocaleForCurrentProcess(locale);
    const completion = new ImageCompletion({}, async () => ({ ok: true, runId: 'run', chatId: 'chat' }));
    assert.equal((await completion.completeImage(request)).message, missing);
    assert.equal(imageGenerateFailureMessage(null), invalid);
    const outcome = { callCount: 0, resultSeen: false, ok: false, message: '', artifacts: [] };
    assert.equal(observeImageGenerateEvent({ type: 'tool.start', toolName: 'shell' }, outcome), true);
    assert.equal(outcome.message, toolError);
    assert.equal(imageGenerateFailureMessage({ message: 'Upstream detail' }), 'Upstream detail');
  }
});
