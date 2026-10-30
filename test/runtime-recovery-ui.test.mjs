import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(new URL('../src/renderer/app-shell/startup/StartupGate.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
} }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', output)(name => name.includes('useI18n')
  ? { useI18n: () => ({ t: key => key }) } : require(name), module, module.exports);

function render(phase, extra = {}) {
  return renderToStaticMarkup(React.createElement(module.exports.StartupLoadingScreen, {
    version: '0.5.30', servicesLoading: false, servicesError: '',
    startupServices: [{ status: 'error' }], timedOut: false,
    onRefresh() {}, onOpenControlCenter() {}, onLogin() {}, loginBusy: false,
    startupRestoreState: { phase, serviceOrder: ['agent-platform'], services: [], ...extra }
  }));
}

test('only a confirmed startup failure offers backup and reinstall', () => {
  assert.match(render('failed'), /settings\.reset\.reinstall/);
  assert.doesNotMatch(render('running'), /settings\.reset\.reinstall/);
  assert.doesNotMatch(render('failed', { authenticationRequired: true }), /settings\.reset\.reinstall/);
});
test('an unfinished reinstall offers rollback instead of another reinstall', () => {
  const html = render('failed', { recoveryBackupPath: '/backup/previous-runtime' });
  assert.match(html, /settings\.reset\.rollback/);
  assert.match(html, /settings\.reset\.backupPath/);
  assert.doesNotMatch(html, /settings\.reset\.reinstall/);
});

test('recovery overlay shows its own stage without a misleading shutdown percentage', () => {
  const input = fs.readFileSync(new URL('../src/renderer/app-shell/DesktopShutdownOverlay.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText;
  const overlay = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(require, overlay, overlay.exports);
  const html = renderToStaticMarkup(React.createElement(overlay.exports.DesktopShutdownOverlay, {
    progress: { phase: 'complete', percent: 100, message: 'old shutdown message' },
    runtimeResetStage: 'restoring', version: '0.5.30', t: key => key
  }));
  assert.match(html, /settings\.reset\.progress\.title/);
  assert.match(html, /settings\.reset\.progress\.restoring/);
  assert.doesNotMatch(html, /old shutdown message|100%|role="progressbar"/);
});
