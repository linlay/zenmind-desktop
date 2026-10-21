import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: [new URL('../src/renderer/app-shell/navigation/projectCreationOptionsCache.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs' });
const module = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(module, module.exports);
const { createProjectCreationOptionsCache, projectCreationOptionsCache } = module.exports;
const options = () => ({ types: [], groups: [], models: [] });
const success = (value = options()) => ({ ok: true, message: '', options: value });

test('prefetch and dialog share one request and publish the successful options', async () => {
  let finish, calls = 0;
  const cache = createProjectCreationOptionsCache(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const prefetch = cache.load(), dialog = cache.load();
  assert.equal(prefetch, dialog);
  await Promise.resolve();
  assert.equal(calls, 1);
  const result = success(); finish(result); await dialog;
  assert.equal(cache.peek(), result.options);
  assert.equal((await cache.load()).options, result.options);
  assert.equal(calls, 1);
});

test('expired options stay readable during refresh and are replaced on success', async () => {
  let now = 1000, calls = 0, finish;
  const first = success(), next = success();
  const cache = createProjectCreationOptionsCache(() => ++calls === 1 ? Promise.resolve(first) : new Promise(resolve => { finish = resolve; }), () => now);
  await cache.load(); now += 30_001;
  const refresh = cache.load(); await Promise.resolve();
  assert.equal(cache.peek(), first.options);
  finish(next); await refresh;
  assert.equal(cache.peek(), next.options);
  assert.equal(calls, 2);
});

test('failed and rejected loads are retryable rather than cached', async () => {
  let calls = 0;
  const cache = createProjectCreationOptionsCache(async () => {
    calls++;
    if (calls === 1) return { ok: false, message: 'offline' };
    if (calls === 2) throw new Error('disconnected');
    return success();
  });
  assert.equal((await cache.load()).ok, false); assert.equal(cache.peek(), null);
  await assert.rejects(cache.load(), /disconnected/); assert.equal(cache.peek(), null);
  assert.equal((await cache.load()).ok, true); assert.equal(calls, 3);
});

test('a failed stale refresh preserves the previous form and allows retry', async () => {
  let now = 0, calls = 0;
  const first = success();
  const cache = createProjectCreationOptionsCache(async () => ++calls === 1 ? first : { ok: false, message: 'offline' }, () => now);
  await cache.load(); now = 30_001;
  await cache.load(); assert.equal(cache.peek(), first.options);
  await cache.load(); assert.equal(calls, 3);
});

test('explicit retry refreshes a still-fresh snapshot', async () => {
  let calls = 0;
  const cache = createProjectCreationOptionsCache(async () => { calls++; return success(); });
  await cache.load(); await cache.load(true); assert.equal(calls, 2);
});

test('caches are isolated by API context and language', async () => {
  const api = { getProjectCreationOptions: async () => success() };
  const zh = projectCreationOptionsCache('zh-CN', api), en = projectCreationOptionsCache('en-US', api);
  await zh.load();
  assert.equal(en.peek(), null);
  assert.equal(projectCreationOptionsCache('zh-CN', api), zh);
  assert.equal(projectCreationOptionsCache('zh-CN', { ...api }).peek(), null);
});
