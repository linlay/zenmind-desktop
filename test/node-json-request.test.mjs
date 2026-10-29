import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { postNodeJson } = require('../dist-electron/main/infrastructure/network/node-json-request.js');

test('Node response construction errors reject the request instead of escaping the end event callback', async t => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(Number(req.url.slice(1)), { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = status => postNodeJson(`http://127.0.0.1:${server.address().port}/${status}`, {
    headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000), maxResponseBytes: 1024
  });
  for (const status of [600, 999]) await assert.rejects(request(status), RangeError);
  const valid = await request(599); assert.equal(valid.status, 599); assert.deepEqual(await valid.json(), {});
  const empty = await request(204); assert.equal(empty.status, 204); assert.equal(await empty.text(), '');
});
