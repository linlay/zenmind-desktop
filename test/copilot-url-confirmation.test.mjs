import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function loadFunction(file, name, bindings) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  const js = ts.transpileModule(found.getText(ast).replace(/^export /, ''), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js}; return ${name};`)(...Object.values(bindings));
}

test('host target is confirmed by guest, allowing agent and chat restoration', () => {
    const pending = { current: '/copilot/cutejWeb' };
    const sessions = [];
    const selections = [];
    const observe = loadFunction('src/renderer/copilot/sidebar-copilot/AgentWebclientCopilotDock.tsx', 'handleCurrentUrlChange', {
      normalizeCopilotEmbedPath: (value) => { const u = new URL(value); return u.pathname + u.search; },
      readCopilotAgentKeyFromUrl: (value) => new URL(value).pathname.split('/')[2],
      readCopilotChatId: (value) => new URL(value, 'http://localhost').searchParams.get('chatId') || '',
      pendingHostTargetEmbedPathRef: pending,
      lastObservedAgentKeyRef: { current: 'cutejWeb' },
      lastObservedEmbedPathRef: { current: '' },
      onCurrentEmbedPathChange: (...args) => sessions.push(args),
      onSelectedAgentKeyChange: (key) => selections.push(key),
    });
    const report = loadFunction('src/renderer/service-webview/ServiceWebviewSurface.tsx', 'updateWebviewCurrentUrl', {
      setWebviewCurrentUrl: () => {},
      canonicalChatPromotionGuardRef: { current: null },
      settleCanonicalChatPromotionGuard: () => {},
      lastReportedCurrentUrlRef: { current: '' },
      lastReportedCurrentUrlSourceRef: { current: null },
      onCurrentUrlChangeRef: { current: observe },
    });
    const target = 'http://localhost/copilot/cutejWeb';
    report(target, 'host');
    assert.equal(sessions.length, 0);
    report(target, 'guest');
    assert.equal(pending.current, '');
    report(target, 'guest');
    assert.equal(sessions.length, 1);
    report('http://localhost/copilot/customAgent', 'guest');
    report('http://localhost/copilot/customAgent?chatId=chat-1', 'guest');
    assert.deepEqual(selections, ['customAgent']);
    assert.deepEqual(sessions.at(-1), ['/copilot/customAgent?chatId=chat-1', 'customAgent', 'chat-1']);
    // A different Website must still reject a late observation from the old one.
    pending.current = '/copilot/otherAgent';
    report('http://localhost/copilot/customAgent?chatId=late-chat', 'guest');
    assert.equal(sessions.length, 3);
    report('http://localhost/copilot/otherAgent', 'host');
    report('http://localhost/copilot/otherAgent', 'guest');
    assert.equal(pending.current, '');
    assert.equal(sessions.at(-1)[1], 'otherAgent');
  });

test('saving a guest route does not block the next selection on the same Dock', () => {
  const refs = [];
  let index = 0;
  const normalize = (value) => value ? new URL(value, 'http://localhost').pathname + new URL(value, 'http://localhost').search : '';
  const readAgent = (value) => new URL(value, 'http://localhost').pathname.split('/')[2] || '';
  const component = loadFunction('src/renderer/copilot/sidebar-copilot/AgentWebclientCopilotDock.tsx', 'AgentWebclientCopilotDock', {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useI18n: () => ({ t: (key) => key }),
    useState: (value) => [value, () => {}],
    useRef: (value) => refs[index++] ?? (refs[index - 1] = { current: value }),
    useEffect: () => {},
    normalizeCopilotEmbedPath: normalize,
    readCopilotAgentKeyFromUrl: readAgent,
    readCopilotChatId: (value) => new URL(value, 'http://localhost').searchParams.get('chatId') || '',
    buildAgentWebclientCopilotPath: (_, agent) => `/copilot/${agent}`,
    resolveTargetAgentKey: (_, agent) => agent,
    AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID: 'copilot-dock',
    createSurfaceIdentity: () => ({}),
    ServiceWebviewSurface: 'surface',
    Suspense: 'suspense',
    SidebarActionIcon: 'icon',
    PRODUCT_NAME: 'test',
  });
  let restoredEmbedPath = '/copilot/cutejWeb';
  const saved = [];
  function render() {
    index = 0;
    const tree = component({
      open: true, openRequest: null, contextKey: 'website:A', resolvedAgentKey: 'cutejWeb',
      restoredEmbedPath,
      onCurrentEmbedPathChange: (path) => { restoredEmbedPath = path; saved.push(path); },
    });
    return tree.children.at(-1).children[0].props.onCurrentUrlChange;
  }
  render()('http://localhost/copilot/cutejWeb', 'guest');
  render()('http://localhost/copilot/cutejWeb?chatId=one', 'guest');
  render()('http://localhost/copilot/customAgent', 'guest');
  render()('http://localhost/copilot/customAgent?chatId=two', 'guest');
  assert.deepEqual(saved, ['/copilot/cutejWeb', '/copilot/cutejWeb?chatId=one', '/copilot/customAgent', '/copilot/customAgent?chatId=two']);
});
