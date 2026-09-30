import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getLanUrls, createLanAccess } = require('../dist-electron/main/modules/webs/webapps/lan-access.js');
const { __gatewayTestInternals: { isLanRequestPathAllowed } } = require('../dist-electron/main/modules/webs/webapps/gateway.js');

test('LAN addresses support macOS and Windows interface names and exclude public, internal and IPv6 addresses', () => {
  for (const name of ['en0', 'Wi-Fi', 'Ethernet']) {
    assert.deepEqual(getLanUrls(4000, { [name]: [
      { family: 'IPv4', internal: false, address: '192.168.1.8' },
      { family: 'IPv4', internal: false, address: '192.168.1.8' },
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
      { family: 'IPv4', internal: false, address: '8.8.8.8' },
      { family: 'IPv6', internal: false, address: 'fe80::1' }
    ] }), ['http://192.168.1.8:4000/']);
  }
  assert.deepEqual(getLanUrls(4000, {}), []);
  for (const [platform, name] of [['darwin', 'en0'], ['win32', 'Wi-Fi']]) {
    assert.deepEqual(getLanUrls(4000, {
      bridge0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
      [name]: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }]
    }, platform), ['http://192.168.1.8:4000/', 'http://172.17.0.1:4000/']);
  }
});

test('LAN listener toggles without closing local server and denies host capabilities even with forged headers', async (t) => {
  const original = os.networkInterfaces;
  os.networkInterfaces = () => ({ test: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }] });
  t.after(() => { os.networkInterfaces = original; });
  let forwarded = 0;
  const local = http.createServer((_req, res) => { forwarded++; res.end('app'); });
  await new Promise((resolve, reject) => { local.once('error', reject); local.listen(0, '127.0.0.1', resolve); });
  const lan = createLanAccess(local, isLanRequestPathAllowed);
  t.after(async () => { await lan.close(); await new Promise(resolve => local.close(resolve)); });
  assert.deepEqual(lan.urls, []);
  await Promise.all([lan.setEnabled(true), lan.setEnabled(true)]);
  const url = new URL(lan.urls[0]);
  const request = (route) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: url.port, path: route,
      headers: { Host: `127.0.0.1:${url.port}`, Origin: `http://127.0.0.1:${url.port}` } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(await request('/'), 200);
  assert.equal(await request('/api/data'), 200);
  for (const route of ['/__desktop/actions/call', '/__desktop/user-config.json', '/__desktop/assistant/image/uploads', '/%5f%5fdesktop/actions/call', '/x/../__desktop/actions/call']) {
    assert.equal(await request(route), 403, route);
  }
  assert.equal(forwarded, 2);
  await lan.setEnabled(false);
  assert.deepEqual(lan.urls, []);
  await assert.rejects(request('/'));
  assert.equal(local.listening, true);
  await lan.setEnabled(true);
  assert.equal(lan.urls.length, 1);
  await lan.close();
  await lan.setEnabled(true);
  assert.deepEqual(lan.urls, []);
});
