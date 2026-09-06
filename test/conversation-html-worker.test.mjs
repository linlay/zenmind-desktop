import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assembleConversationHtml,
  fetchLimitedResponse,
  parseConversationHtmlTemplate
} = require("../dist-electron/main/modules/conversation-share/html-worker.js");
const {
  ConversationHtmlRenderService
} = require("../dist-electron/main/modules/conversation-share/html-render-service.js");

const SNAPSHOT_MARKER = "__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__";
const ASSET_ORIGIN_MARKER = "__CONVERSATION_EXPORT_ASSET_ORIGIN__";

function templateBytes() {
  return Buffer.from(
    `<link href="${ASSET_ORIGIN_MARKER}/runtime.css"><script type="application/json">${SNAPSHOT_MARKER}</script><script src="${ASSET_ORIGIN_MARKER}/runtime.js"></script>`
  );
}

test("conversation HTML byte assembler escapes script-sensitive snapshot bytes", () => {
  const template = parseConversationHtmlTemplate(templateBytes());
  const snapshot = Buffer.from('{"text":"</script>&\u2028\u2029"}');
  const html = Buffer.from(assembleConversationHtml(
    template,
    snapshot,
    "http://127.0.0.1:11961"
  )).toString("utf8");

  assert.doesNotMatch(html, /<\/script>&/u);
  assert.match(html, /\\u003c\/script\\u003e\\u0026\\u2028\\u2029/u);
  assert.equal(html.split("http://127.0.0.1:11961").length - 1, 2);
  assert.doesNotMatch(html, /__CONVERSATION_EXPORT_/u);

  const emptySnapshotHtml = Buffer.from(assembleConversationHtml(
    template,
    Buffer.alloc(0),
    "http://127.0.0.1:11961"
  )).toString("utf8");
  assert.doesNotMatch(emptySnapshotHtml, /__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__/u);
});

test("conversation HTML template requires one snapshot marker and at least one asset marker", () => {
  for (const template of [
    SNAPSHOT_MARKER,
    `${SNAPSHOT_MARKER}${SNAPSHOT_MARKER}${ASSET_ORIGIN_MARKER}`,
    ASSET_ORIGIN_MARKER
  ]) {
    assert.throws(
      () => parseConversationHtmlTemplate(Buffer.from(template)),
      /template_invalid/u
    );
  }
  assert.throws(
    () => parseConversationHtmlTemplate(Buffer.from([0xff, ...templateBytes()])),
    /template_invalid/u
  );
});

test("conversation HTML worker aborts a timed-out response with a structured code", async (t) => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "2"
      });
      res.end("{}");
    }, 100);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await assert.rejects(
    fetchLimitedResponse({
      url: `http://127.0.0.1:${address.port}/slow`,
      headers: { Accept: "application/json" },
      timeoutMs: 20,
      maxBytes: 32,
      expectedContentType: "application/json",
      unavailableCode: "snapshot_unavailable",
      invalidCode: "snapshot_invalid"
    }),
    (error) => error?.code === "snapshot_unavailable"
  );
});

test("conversation HTML render service keeps template fetch and assembly inside one persistent worker", async (t) => {
  const snapshot = Buffer.from('{"version":1,"title":"安全 </script>","turns":[]}');
  const template = templateBytes();
  let templateRequests = 0;
  let snapshotRequests = 0;
  let redirectedRequests = 0;
  let snapshotMode = "normal";
  let activeSnapshotRequests = 0;
  let maximumActiveSnapshotRequests = 0;
  let serviceVersion = "1.0.0";
  let origin = "";
  let snapshotUrlOverride = "";
  const snapshotFilename = "中文 对话 #100%.snapshot.json";
  const snapshotContentDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(snapshotFilename)}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/export/conversation.template.html") {
      templateRequests += 1;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(template.length)
      });
      res.end(template);
      return;
    }
    if (url.pathname === "/api/chat/export" && url.searchParams.get("format") === "snapshot") {
      snapshotRequests += 1;
      assert.equal(req.headers.authorization, "Bearer desktop-token");
      if (snapshotMode === "redirect") {
        res.writeHead(302, { Location: `${origin}/redirected` });
        res.end();
        return;
      }
      if (snapshotMode === "content-type") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": String(snapshot.length)
        });
        res.end(snapshot);
        return;
      }
      if (snapshotMode === "missing-length") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.write(snapshot);
        res.end();
        return;
      }
      if (snapshotMode === "fifo") {
        activeSnapshotRequests += 1;
        maximumActiveSnapshotRequests = Math.max(
          maximumActiveSnapshotRequests,
          activeSnapshotRequests
        );
        setTimeout(() => {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(snapshot.length),
            "Content-Disposition": snapshotContentDisposition
          });
          res.end(snapshot, () => {
            activeSnapshotRequests -= 1;
          });
        }, 20);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(snapshot.length),
        "Content-Disposition": snapshotContentDisposition
      });
      res.end(snapshot);
      return;
    }
    if (url.pathname === "/redirected") {
      redirectedRequests += 1;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(snapshot.length)
      });
      res.end(snapshot);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  const renderer = new ConversationHtmlRenderService({
    app: {},
    snapshotProvider: {
      async createChatSnapshotRequest(chatId) {
        return {
          ok: true,
          snapshotUrl: snapshotUrlOverride ||
            `${origin}/api/chat/export?chatId=${encodeURIComponent(chatId)}&format=snapshot`,
          bearerToken: "desktop-token"
        };
      }
    },
    getServiceState: async () => ({
      status: "running",
      version: serviceVersion,
      healthMeta: { webUrl: origin }
    })
  });
  renderer.start();
  t.after(() => renderer.dispose());

  const first = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  const second = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.filename, "中文 对话 #100%.html");
  assert.equal(templateRequests, 1);
  assert.equal(snapshotRequests, 2);
  assert.match(first.bytes.toString("utf8"), /安全 \\u003c\/script\\u003e/u);
  assert.equal(Buffer.compare(first.bytes, second.bytes), 0);

  snapshotMode = "fifo";
  const concurrent = await Promise.all([
    renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961"),
    renderer.renderChatHtml("chat_2", "http://127.0.0.1:11961")
  ]);
  assert.deepEqual(concurrent.map((result) => result.ok), [true, true]);
  assert.equal(maximumActiveSnapshotRequests, 1);

  snapshotMode = "normal";
  serviceVersion = "2.0.0";
  const versionChanged = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  assert.equal(versionChanged.ok, true);
  assert.equal(templateRequests, 2);

  snapshotMode = "redirect";
  const redirected = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  assert.equal(redirected.ok, false);
  assert.equal(redirectedRequests, 0);

  snapshotMode = "content-type";
  const wrongContentType = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  assert.equal(wrongContentType.ok, false);

  snapshotMode = "missing-length";
  const missingLength = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  assert.equal(missingLength.ok, false);

  snapshotMode = "normal";
  snapshotUrlOverride = "https://example.com/api/chat/export?chatId=chat_1&format=snapshot";
  const untrustedSnapshot = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  assert.equal(untrustedSnapshot.ok, false);
  snapshotUrlOverride = "";

  assert.ok(renderer.worker);
  await renderer.worker.terminate();
  const recovered = await renderer.renderChatHtml("chat_1", "http://127.0.0.1:11961");
  assert.equal(recovered.ok, true);
  assert.equal(templateRequests, 3);
});
