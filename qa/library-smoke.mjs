// Render the production Library in an isolated Electron profile, with no user data or services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-library-'));
const { APP_BRAND } = require('../dist-electron/shared/brand.js');
await build({ entryPoints: ['qa/library-fixture.tsx'], outfile: path.join(output, 'app.js'), bundle: true, platform: 'browser', jsx: 'automatic', loader: { '.svg': 'file', '.png': 'file', '.woff2': 'file' }, define: { 'process.env.NODE_ENV': '"development"', __DESKTOP_APP_BRAND__: JSON.stringify(APP_BRAND), __LIBRARY_QA_IMAGE__: JSON.stringify('data:image/png;base64,' + fs.readFileSync('qa/assets/alpine-lake.png').toString('base64')) } });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
fs.copyFileSync('qa/library-checks.cjs', path.join(output, 'checks.cjs'));
const env = { ...process.env, LIBRARY_QA_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(output, 'checks.cjs')], { env, stdio: 'inherit' });
process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
if (process.exitCode === 0 && !fs.existsSync(path.join(output, 'passed'))) throw new Error('Electron exited before completing QA: ' + output);
