import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const item = { id: 'suite', name: 'Suite', type: 'skill', state: 'not-installed', skill: { kind: 'package' } };
const proposal = { archiveSha256: 'archive-1', skills: [{ id: 'meeting', revision: 'revision-1', changedPaths: ['SKILL.md', 'references/help.md'] }] };
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
function harness() {
  const slots = []; let index = 0; const calls = [];
  let outcome = { ok: false, itemId: item.id, type: 'skill', state: 'not-installed', skillPackageAdoption: proposal };
  const react = {
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { return slots[index++] ||= { current: initial }; }, useMemo: fn => fn(), useEffect() {}
  };
  const api = { async install(...args) { calls.push(args); if (outcome instanceof Error) throw outcome; return outcome; }, async list() { return { items: [item] }; }, async refresh() { return { items: [item] }; } };
  const defaults = new Proxy({}, { get: (_, key) => key });
  const source = fs.readFileSync(new URL('../src/renderer/pages/functional-market/StorefrontMarket.tsx', import.meta.url), 'utf8') + '\nexport { StorefrontMarketContent };';
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console: { warn() {} }, window: { electronAPI: { sso: { async getStatus() { return { authenticated: true }; } } } }, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'react-router-dom') return { useNavigate: () => () => {} };
    if (name.endsWith('/useI18n')) return { useI18n: () => ({ locale: 'en-US', t: key => key }) };
    if (name.endsWith('/ServicesContext')) return { useServices: () => ({ services: [], refresh: async () => {} }) };
    if (name === './marketPageApi') return { getMarketMethod: key => api[key], normalizeError: e => e.message };
    if (name === './marketPageModel') return { MARKET_TAB_ITEM_TYPES: { skills: 'skill' }, createEmptyMarketResult: () => ({ items: [] }), getMarketTabDefinitions: () => [] };
    return defaults;
  } });
  return { calls, set outcome(value) { outcome = value; }, render() { index = 0; return module.exports.StorefrontMarketContent({ activeTab: 'skills', onTabChange() {} }); }, modal() { return elements(this.render().props.detail).find(n => n.type === 'Modal'); } };
}

test('package adoption shows differences without installing; cancel leaves existing skills untouched', async () => {
  const h = harness();
  assert.equal(await h.render().props.onInstall(item, 'install'), false);
  const modal = h.modal();
  assert.equal(modal.props.open, true);
  assert.ok(JSON.stringify(modal).includes('references/help.md'));
  assert.equal(h.calls.length, 1);
  modal.props.onCancel();
  assert.equal(h.modal().props.open, false);
  assert.equal(h.calls.length, 1);
});
test('explicit confirmation sends the reviewed archive and exact skill revisions', async () => {
  const h = harness(); await h.render().props.onInstall(item, 'install');
  h.outcome = { ok: true, itemId: item.id, type: 'skill', state: 'installed', message: 'installed' };
  h.modal().props.onOk();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), ['suite', { skillPackageAdoption: { archiveSha256: 'archive-1', expectedRevisions: { meeting: 'revision-1' } } }]);
  assert.equal(h.modal().props.open, false);
});
test('stale or failed confirmation keeps the dialog and reports the failure instead of success', async () => {
  const h = harness(); await h.render().props.onInstall(item, 'install');
  h.outcome = new Error('revision changed'); h.modal().props.onOk();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.modal().props.open, true);
  assert.ok(JSON.stringify(h.modal()).includes('revision changed'));
});

test('confirmation stays busy and ignores duplicate submissions until the command finishes', async () => {
  const h = harness(); await h.render().props.onInstall(item, 'install');
  let resolve;
  h.outcome = new Promise(done => { resolve = done; });
  h.modal().props.onOk();
  await new Promise(done => setImmediate(done));
  const busyModal = h.modal();
  assert.equal(busyModal.props.confirmLoading, true);
  assert.equal(busyModal.props.closable, false);
  assert.equal(busyModal.props.cancelButtonProps.disabled, true);
  busyModal.props.onOk(); busyModal.props.onCancel();
  assert.equal(h.calls.length, 2);
  assert.equal(h.modal().props.open, true);
  resolve({ ok: true, itemId: item.id, type: 'skill', state: 'installed', message: 'installed' });
  await new Promise(done => setImmediate(done));
  assert.equal(h.modal().props.open, false);
});
