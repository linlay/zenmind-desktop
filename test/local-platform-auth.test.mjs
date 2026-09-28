import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { issueAgentAccessToken } = require('../dist-electron/main/modules/identity/agent-auth.js');
for (const platform of ['darwin', 'win32']) {
  test(`local app token is single-flight and refreshable on ${platform}`, async () => {
    const app = {getPath: name => platform === 'win32' ? `C:/local-auth/${name}` : `/local-auth/${name}`};
    let calls = 0;
    const resolve = async (...args) => {
      assert.equal(args.length, 2, 'no website subject override');
      assert.equal(args[1], 'auth.accessToken');
      calls++;
      await new Promise(resolve => setImmediate(resolve));
      return {token: `local-token-${calls}`};
    };
    const results = await Promise.all(Array.from({length: 3}, () => issueAgentAccessToken(app, 'missing', resolve)));
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.ok && result.token === 'local-token-1'));
    assert.equal((await issueAgentAccessToken(app, 'missing', resolve)).token, 'local-token-1');
    assert.equal((await issueAgentAccessToken(app, 'unauthorized', resolve)).token, 'local-token-2');
    assert.equal(calls, 2);
  });
}
