import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WorkPanelPageAutomation } = require('../dist-electron/main/modules/web-surfaces/cdp/page-automation.js');

function fixture() {
  const contents = new EventEmitter(), debuggerRef = new EventEmitter(), session = new EventEmitter();
  let attached = false;
  const commands = [], focus = [], logs = [];
  debuggerRef.isAttached = () => attached;
  debuggerRef.attach = () => { attached = true; };
  debuggerRef.sendCommand = async (method, params) => {
    commands.push({ method, params });
    if (method === 'Page.handleJavaScriptDialog') debuggerRef.emit('message', {}, 'Page.javascriptDialogClosed', { result: params.accept, userInput: params.promptText });
    return {};
  };
  Object.assign(contents, { id: 701, debugger: debuggerRef, session, isDestroyed: () => false });
  const logger = { debug: (...args) => logs.push(args), warn: (...args) => logs.push(args) };
  const automation = new WorkPanelPageAutomation(logger);
  return { contents, automation, commands, focus, logs,
    setFocus: async enabled => { focus.push(enabled); },
    open: type => debuggerRef.emit('message', {}, 'Page.javascriptDialogOpening', { type, message: 'Synthetic dialog', hasBrowserHandler: true }),
    chooser: () => debuggerRef.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 12, mode: 'selectSingle' }),
    close: (result = false) => debuggerRef.emit('message', {}, 'Page.javascriptDialogClosed', { result }),
    detach: () => debuggerRef.emit('detach', {}, 'target_closed'),
  };
}

for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) test(`pending ${type} does not block focus cleanup or dialog handling`, async t => {
  const f = fixture(); t.after(() => f.automation.dispose());
  await f.automation.prepare(f.contents);
  const release = await f.automation.acquireFocus(f.contents, f.setFocus);
  f.open(type);
  await release();
  assert.deepEqual(f.focus, [true], 'cleanup must wait outside the action while the native dialog blocks Chromium');
  await f.automation.prepare(f.contents);
  assert.deepEqual(f.focus, [true], 'observing/handling the pending modal must not enable or disable focus');
  const modal = f.automation.modalState(f.contents).dialogs[0];
  await assert.rejects(f.automation.handleDialog(f.contents, modal.dialogId, true, type === 'prompt' ? 'Ada' : undefined), { code: 'capability_unavailable' });
  assert.equal(f.commands.some(command => command.method === 'Page.handleJavaScriptDialog'), false, 'CDP cannot dismiss Electron native UI');
  f.close(); await f.automation.prepare(f.contents);
  assert.deepEqual(f.focus, [true, false]);
  assert.equal(f.automation.modalState(f.contents).dialogs.length, 0);
});

test('file chooser completion restores deferred focus without a JavaScript dialog-close event', async t => {
  const f = fixture(); t.after(() => f.automation.dispose());
  await f.automation.prepare(f.contents);
  const release = await f.automation.acquireFocus(f.contents, f.setFocus);
  f.chooser(); await release();
  assert.deepEqual(f.focus, [true]);
  const chooser = f.automation.modalState(f.contents).fileChoosers[0];
  f.automation.completeChooser(f.contents, chooser.chooserId);
  await f.automation.prepare(f.contents);
  assert.deepEqual(f.focus, [true, false]);
});

test('a focus cleanup failure preserves the action release and is retried before the next command', async t => {
  const f = fixture(); t.after(() => f.automation.dispose());
  await f.automation.prepare(f.contents);
  let failures = 0;
  const release = await f.automation.acquireFocus(f.contents, async enabled => {
    f.focus.push(enabled);
    if (!enabled && failures++ === 0) throw new Error('Synthetic cleanup failure');
  });
  await assert.doesNotReject(release);
  assert.deepEqual(f.focus, [true, false]);
  await f.automation.prepare(f.contents);
  assert.deepEqual(f.focus, [true, false, false]);
});

test('an already-open modal rejects a raced command without waiting for another modal event', async t => {
  const f = fixture(); t.after(() => f.automation.dispose());
  await f.automation.prepare(f.contents); f.open('alert');
  await assert.rejects(f.automation.raceModal(f.contents, new Promise(() => {})), { code: 'dialog_pending' });
});

test('teardown queues pending focus restoration without blocking on an unanswered dialog', async () => {
  const f = fixture(); await f.automation.prepare(f.contents);
  const release = await f.automation.acquireFocus(f.contents, f.setFocus);
  f.open('confirm'); await release(); f.automation.dispose();
  await Promise.resolve();
  assert.deepEqual(f.focus, [true, false]);
});

test('native dialog diagnostics record external closes without page text', async t => {
  const f = fixture(); t.after(() => f.automation.dispose());
  await f.automation.prepare(f.contents);
  f.open('confirm'); f.close(true);
  f.open('prompt'); f.close(false);
  f.open('alert'); f.detach();
  const closed = f.logs.filter(([event]) => event === '[desktop-cdp] dialog-closed').map(([, data]) => data);
  assert.equal(closed.length, 2);
  assert.equal(closed[0].result, true);
  assert.equal(closed[0].handledByAgent, false);
  assert.equal(closed[1].handledByAgent, false);
  assert.equal(f.logs.at(-1)[1].reason, 'target_closed');
  assert.equal(f.logs.at(-1)[1].dialogIds.length, 1);
  assert.equal(JSON.stringify(f.logs).includes('Synthetic dialog'), false);
  assert.equal(JSON.stringify(f.logs).includes('private-answer'), false);
  for (const [, data] of f.logs) for (const key of Object.keys(data)) {
    assert.ok(['webContentsId', 'dialogId', 'dialogIds', 'type', 'hasBrowserHandler', 'result', 'handledByAgent', 'reason'].includes(key));
  }
});
