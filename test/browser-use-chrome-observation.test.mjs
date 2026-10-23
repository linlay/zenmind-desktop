import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromeObserveOptions, scanChromeSnapshot, projectChromeObservation, viewportChromeSnapshot, CHROME_OBSERVATION_MAX_BYTES } = require('../dist-electron/main/modules/browser-use/chrome-observation.js');
function project(nodes, fields = new Map(), params = {}, extra = {}) {
  return projectChromeObservation({ scan: scanChromeSnapshot(nodes), fields,
    state: { pageId: 'owned-page', url: 'https://fixture.example/', title: 'Fixture' },
    observationId: 'observation-fixture', options: chromeObserveOptions(params), ...extra });
}

test('Chrome projection retains mixed string children and ARIA states in text and structured elements', () => {
  const { observation } = project([
    { role: 'paragraph', children: ['价格：', { role: 'strong', text: '999' }, '元/件（含税）'] },
    { role: 'checkbox', ref: 'e1', name: '复核', checked: 'mixed', disabled: true },
    { role: 'combobox', ref: 'e2', name: '地区', expanded: true, invalid: true, selected: true, active: true },
    { role: 'button', ref: 'e3', name: '工具', pressed: 'mixed', level: 2 },
  ]);
  for (const text of ['价格：', '999', '元/件（含税）', '[checked=mixed]', '[disabled=true]', '[expanded=true]', '[invalid=true]', '[selected=true]']) assert.ok(observation.text.includes(text), text);
  assert.equal(observation.elements[0].checked, 'mixed');
  assert.equal(observation.elements[0].disabled, true);
  assert.equal(observation.elements[1].expanded, true);
  assert.equal(observation.elements[1].invalid, true);
  assert.equal(observation.elements[2].pressed, 'mixed');
  assert.equal(observation.truncated, false);
});

test('the complete UTF-8 response, field lengths and traversal share strict budgets', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: '设备😀'.repeat(10000) }));
  const { observation, refs } = project(nodes);
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= CHROME_OBSERVATION_MAX_BYTES);
  assert.ok(observation.text.length <= 30000);
  assert.ok(observation.elements.length <= 500);
  assert.ok(observation.elements.every(element => element.name.length <= 512));
  assert.equal(refs.size, observation.elements.length);
  assert.equal(observation.truncated, true);
  const invalid = scanChromeSnapshot(Array(10000).fill(null));
  assert.equal(invalid.entries.length, 0); assert.equal(invalid.truncated, true);
  let deep = { role: 'button', ref: 'e1' }; for (let i = 0; i < 100; i++) deep = { role: 'generic', children: [deep] };
  assert.equal(scanChromeSnapshot([deep]).truncated, true);
});

test('sensitive values are masked before clipping, including mixed children and copied labels', () => {
  const secret = 'PASSWORD_SECRET_LONG';
  const fields = new Map([['e1', { sensitive: true, secretValue: secret, tag: 'input' }], ['e4', { sensitive: true, secretValue: 'C:\\fakepath\\private.txt', tag: 'input' }]]);
  const { observation } = project([
    { role: 'textbox', ref: 'e1', name: 'Password', text: secret, children: [secret, { role: 'text', text: secret }] },
    { role: 'button', ref: 'e2', name: 'x'.repeat(505) + secret + 'tail' },
    { role: 'text', text: 'Copied ' + secret },
    { role: 'button', ref: 'e4', name: 'File', text: 'C:\\fakepath\\private.txt' },
    { role: 'textbox', name: 'Unreferenced editable', text: 'UNREFERENCED_SECRET', children: ['UNREFERENCED_SECRET'] },
  ], fields);
  const encoded = JSON.stringify(observation);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('PASSWORD_'), false, 'clipping must not reveal a secret prefix');
  assert.equal(encoded.includes('fakepath'), false);
  assert.equal(encoded.includes('UNREFERENCED_SECRET'), false);
  assert.equal(observation.elements[0].value, '[redacted]');
});

test('native select options retain exact values and selected/disabled state within the total budget', () => {
  const options = [{ label: '验收后付款', value: ' net 30 ', selected: true, disabled: false },
    { label: '不可用', value: 'blocked', selected: false, disabled: true },
    ...Array.from({ length: 120 }, (_, i) => ({ label: 'Option ' + i, value: String(i) + 'v'.repeat(900), selected: false, disabled: false }))];
  const { observation } = project([{ role: 'listbox', ref: 'e1', name: '付款', text: '验收后付款' }],
    new Map([['e1', { sensitive: false, tag: 'select', select: { options, multiple: true, optionsTruncated: true } }]]));
  const element = observation.elements[0];
  assert.equal(element.options[0].value, ' net 30 '); assert.equal(element.options[0].selected, true);
  assert.equal(element.options[1].disabled, true); assert.equal(element.multiple, true);
  assert.ok(element.options.length <= 100);
  assert.equal(element.optionsTruncated, true); assert.equal(observation.truncated, true);
  assert.ok(element.options.reduce((sum, option) => sum + option.value.length + option.label.length, 0) <= 24000);
});

test('public observation budgets are honored and metadata is bounded without inventing exact values', () => {
  const { observation } = project([{ role: 'textbox', ref: 'e1', name: 'Budget', placeholder: '请输入', invalid: true }, { role: 'button', ref: 'e2', name: 'Other' }],
    new Map([['e1', { sensitive: false, tag: 'input', value: 'x'.repeat(4096), required: true, readOnly: true, validationMessage: '需要有效内容' }]]),
    { maxTextLength: 16, maxElements: 1 });
  assert.ok(observation.text.length <= 16); assert.equal(observation.elements.length, 1);
  assert.equal(observation.elements[0].value, undefined); assert.equal(observation.elements[0].required, true);
  assert.equal(observation.elements[0].readOnly, true); assert.equal(observation.elements[0].invalid, true);
  assert.equal(observation.truncated, true);
  for (const params of [{ maxTextLength: 30001 }, { maxElements: 501 }, { maxElements: 1.5 }, { maxTextLength: 0 }, { selector: '#root' }]) assert.throws(() => chromeObserveOptions(params), { code: 'invalid_params' });
});

test('viewport projection keeps visible descendants/ancestors, excludes offscreen names and never compares iframe-local boxes to the top frame', () => {
  const projected = viewportChromeSnapshot([
    { role: 'generic', box: { x: 0, y: -100, width: 800, height: 10000 }, children: [
      { role: 'button', ref: 'e1', name: 'Offscreen', box: { x: 0, y: -90, width: 100, height: 20 } },
      { role: 'button', ref: 'e2', name: 'Visible', box: { x: 0, y: 20, width: 100, height: 20 } },
      { role: 'iframe', ref: 'e3', box: { x: 0, y: 60, width: 300, height: 200 }, children: [{ role: 'button', ref: 'f1e1', name: 'Frame-local', box: { x: 0, y: 2000, width: 80, height: 20 } }] },
      { role: 'iframe', ref: 'e4', box: { x: 0, y: 2000, width: 300, height: 200 }, children: [{ role: 'button', ref: 'f2e1', name: 'Hidden frame-local', box: { x: 0, y: 0, width: 80, height: 20 } }] },
    ] },
  ], 800, 600);
  const encoded = JSON.stringify(projected.nodes);
  assert.equal(encoded.includes('Offscreen'), false); assert.equal(encoded.includes('Hidden frame-local'), false);
  assert.ok(encoded.includes('Visible')); assert.ok(encoded.includes('Frame-local')); assert.equal(projected.truncated, true);
  assert.throws(() => chromeObserveOptions({ viewportOnly: 'yes' }), { code: 'invalid_params' });
});

test('known sensitive values are masked in native dialog messages without returning any default value', () => {
  const { observation } = project([], new Map(), {}, { redactions: new Set(['KNOWN_PRIVATE_VALUE']), dialogs: [{ dialogId: 'opaque-dialog', type: 'prompt', message: 'Confirm KNOWN_PRIVATE_VALUE' }] });
  assert.equal(observation.dialogs[0].message, 'Confirm [redacted]');
  assert.equal('defaultValue' in observation.dialogs[0], false);
});
