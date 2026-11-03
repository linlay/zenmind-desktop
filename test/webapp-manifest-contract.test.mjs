import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { safeParseWebappManifest as parseGenerated } from '../contracts/webapp/webapp-manifest-validator.mjs';

const require = createRequire(import.meta.url);
const { safeParseWebappManifest: parseSource } = require('../dist-electron/shared/webapp-manifest.js');
const { WEBAPP_TARGETS, webappTargetMatchesCurrentPlatform } = require('../dist-electron/main/modules/webs/webapps/store.js');
const { normalizeStoredTarget } = require('../dist-electron/main/modules/webs/webapps/runtime-state.js');
const fixtures = JSON.parse(fs.readFileSync(new URL('../contracts/webapp/fixtures/manifest-v2.json', import.meta.url), 'utf8'));
const schema = JSON.parse(fs.readFileSync(new URL('../contracts/webapp/webapp.schema.json', import.meta.url), 'utf8'));

assert.equal(fixtures.schemaVersion, 1);
for (const fixture of fixtures.cases) test(`shared Manifest fixture: ${fixture.name}`, () => {
  const source = parseSource(fixture.manifest);
  const generated = parseGenerated(fixture.manifest);
  assert.equal(source.success, fixture.valid, 'source validator');
  assert.equal(generated.success, fixture.valid, 'generated validator');
  if (fixture.valid) assert.deepEqual(generated.data, source.data);
});

test('Linux target is preserved in the contract and stored state without enabling Desktop hosting', () => {
  assert.deepEqual([...WEBAPP_TARGETS], schema.properties.target.enum);
  assert.equal(normalizeStoredTarget('linux-x64', 'any'), 'linux-x64');
  for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['arm64', 'x64']) {
    assert.equal(webappTargetMatchesCurrentPlatform('linux-x64', platform, arch), false, `${platform}/${arch}`);
  }
});

test('macOS and Windows target matching remains explicit across both architectures', () => {
  for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
    for (const target of WEBAPP_TARGETS) {
      const expected = target === 'any' || target === `${platform}-${arch}` ||
        (platform === 'darwin' && target === 'darwin-universal');
      assert.equal(webappTargetMatchesCurrentPlatform(target, platform, arch), expected, `${target} on ${platform}/${arch}`);
    }
  }
});
