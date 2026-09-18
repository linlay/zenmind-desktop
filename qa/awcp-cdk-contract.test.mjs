import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSiteHarness } = require('../test/fixtures/site-cdp-harness.cjs');
const { AwcpGuestBridge } = require('../dist-electron/main/modules/web-surfaces/awcp/guest-bridge.js');

function cdkSource() {
  const root = process.env.AWCP_CDK_SOURCE;
  assert.ok(root, 'AWCP_CDK_SOURCE must point to the CDK source directory');
  for (const relative of ['docs/awcp/awcp.schema.json', 'docs/awcp/examples.json', 'packages/core/src/lib/awcp/registry.ts']) {
    assert.ok(fs.statSync(path.join(root, relative)).isFile(), `missing CDK contract source: ${relative}`);
  }
  return root;
}

test('Desktop accepts the current CDK v2 examples without compatibility translation', async (t) => {
  const root = cdkSource();
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs/awcp/awcp.schema.json'), 'utf8'));
  const examples = JSON.parse(fs.readFileSync(path.join(root, 'docs/awcp/examples.json'), 'utf8'));
  const registrySource = fs.readFileSync(path.join(root, 'packages/core/src/lib/awcp/registry.ts'), 'utf8');
  assert.equal(schema.$id, 'https://qfc.internal/schemas/awcp-2.0.schema.json');
  assert.match(registrySource, /export function createAwcpRegistry/);

  const h = createSiteHarness(); const site = h.site('cdk-v2'); const scope = h.capture(site); scope.activate();
  const guest = h.contents.get(site.tabs[0].webContentsId);
  guest.executeJavaScript = async (script) => {
    if (script.includes('actualVersion')) {
      return { present: true, entryType: 'object', actualVersion: 2, manualType: 'function', invokeType: 'function' };
    }
    if (script.includes('.manual(')) return script.includes('section') ? examples.manualSection : examples.manualIndex;
    return examples.successResponse;
  };
  const bridge = new AwcpGuestBridge(h.registry); t.after(() => { bridge.dispose(); scope.release(); });
  const index = await bridge.manual('cdk-index', {}, scope);
  await bridge.manual('cdk-section', examples.manualRequest, scope);
  const response = await bridge.invoke(examples.invokeRequest.requestId, {
    revision: examples.invokeRequest.revision,
    action: examples.invokeRequest.action,
    args: examples.invokeRequest.args,
  }, scope);
  assert.equal(index.revision, examples.manualIndex.revision);
  assert.deepEqual(response, examples.successResponse);
});
