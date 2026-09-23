import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assembleConversationHtml,
  fetchLimitedResponse,
  isCanonicalArtifactRef,
  parseConversationHtmlTemplate
} = require("../dist-electron/main/modules/conversation-share/html-worker.js");

test("conversation resource references use canonical Platform path encoding", () => {
  assert.equal(isCanonicalArtifactRef("artifacts/run-1/%E6%8A%A5%E5%91%8A.html"), true);
  assert.equal(isCanonicalArtifactRef("artifacts/run-1/report+v1.pdf"), true);
  for (const value of [
    "artifacts/run-1/报告.html",
    "artifacts/run-1/%e6%8a%a5%e5%91%8a.html",
    "artifacts/run-1/%2e%2e",
    "artifacts/run-1/%252e%252e",
    "artifacts/run-1/a%2Fb.html",
    "artifacts/run-1/nested/report.html"
  ]) assert.equal(isCanonicalArtifactRef(value), false, value);
});
const {
  ConversationHtmlRenderService
} = require("../dist-electron/main/modules/conversation-share/html-render-service.js");

const SNAPSHOT_MARKER = "__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__";
const ASSET_ORIGIN_MARKER = "__CONVERSATION_EXPORT_ASSET_ORIGIN__";
const LOCAL_BRAND_ID_MARKER = "__CONVERSATION_EXPORT_LOCAL_BRAND_ID__";

function templateBytes() {
  return Buffer.from(
    `<meta name="conversation-export-local-brand" content="${LOCAL_BRAND_ID_MARKER}"><link href="${ASSET_ORIGIN_MARKER}/runtime.css"><script type="application/json">${SNAPSHOT_MARKER}</script><script src="${ASSET_ORIGIN_MARKER}/runtime.js"></script>`
  );
}

test("conversation HTML byte assembler escapes script-sensitive snapshot bytes", () => {
  const template = parseConversationHtmlTemplate(templateBytes());
  const snapshot = Buffer.from('{"text":"</script>&\u2028\u2029"}');
  const html = Buffer.from(assembleConversationHtml(
    template,
    snapshot,
    "http://127.0.0.1:11961",
    "cutej"
  )).toString("utf8");

  assert.doesNotMatch(html, /<\/script>&/u);
  assert.match(html, /\\u003c\/script\\u003e\\u0026\\u2028\\u2029/u);
  assert.equal(html.split("http://127.0.0.1:11961").length - 1, 2);
  assert.match(html, /conversation-export-local-brand" content="cutej"/u);
  assert.doesNotMatch(html, /__CONVERSATION_EXPORT_/u);

  const emptySnapshotHtml = Buffer.from(assembleConversationHtml(
    template,
    Buffer.alloc(0),
    "http://127.0.0.1:11961",
    "cutej"
  )).toString("utf8");
  assert.doesNotMatch(emptySnapshotHtml, /__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__/u);
});

test("conversation HTML template requires one snapshot marker and at least one asset marker", () => {
  for (const template of [
    SNAPSHOT_MARKER,
    `${SNAPSHOT_MARKER}${SNAPSHOT_MARKER}${ASSET_ORIGIN_MARKER}`,
    ASSET_ORIGIN_MARKER,
    `${SNAPSHOT_MARKER}${ASSET_ORIGIN_MARKER}`
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
  const snapshot = Buffer.from('{"version":1,"title":"安全 </script>","turns":[],"attachments":[]}');
  const template = templateBytes();
  let templateRequests = 0;
  let snapshotRequests = 0;
  let redirectedRequests = 0;
  let snapshotMode = "normal";
  let activeSnapshotRequests = 0;
  let maximumActiveSnapshotRequests = 0;
  let origin = "";
  let snapshotUrlOverride = "";
  const snapshotFilename = "中文 对话 #100%.snapshot.json";
  const snapshotContentDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(snapshotFilename)}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/assets/conversation-export/conversation.template.html") {
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
    snapshotProvider: {
      async createChatSnapshotRequest(chatId) {
        return {
          ok: true,
          snapshotUrl: snapshotUrlOverride ||
            `${origin}/api/chat/export?chatId=${encodeURIComponent(chatId)}&format=snapshot`,
          bearerToken: "desktop-token"
        };
      }
    }
  });
  renderer.start();
  t.after(() => renderer.dispose());

  const first = await renderer.renderChatHtml("chat_1", origin);
  const second = await renderer.renderChatHtml("chat_1", origin);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.filename, "中文 对话 #100%.html");
  assert.equal(templateRequests, 1);
  assert.equal(snapshotRequests, 2);
  assert.match(first.bytes.toString("utf8"), /安全 \\u003c\/script\\u003e/u);
  assert.equal(Buffer.compare(first.bytes, second.bytes), 0);

  snapshotMode = "fifo";
  const concurrent = await Promise.all([
    renderer.renderChatHtml("chat_1", origin),
    renderer.renderChatHtml("chat_2", origin)
  ]);
  assert.deepEqual(concurrent.map((result) => result.ok), [true, true]);
  assert.equal(maximumActiveSnapshotRequests, 1);

  snapshotMode = "normal";
  const snapshotOnly = await renderer.readChatSnapshot("chat_1");
  assert.equal(snapshotOnly.ok, true);
  assert.equal(Buffer.compare(snapshotOnly.bytes, snapshot), 0);
  assert.deepEqual(snapshotOnly.attachments, []);
  assert.equal(templateRequests, 1);

  snapshotMode = "redirect";
  const redirected = await renderer.renderChatHtml("chat_1", origin);
  assert.equal(redirected.ok, false);
  assert.equal(redirectedRequests, 0);

  snapshotMode = "content-type";
  const wrongContentType = await renderer.renderChatHtml("chat_1", origin);
  assert.equal(wrongContentType.ok, false);

  snapshotMode = "missing-length";
  const missingLength = await renderer.renderChatHtml("chat_1", origin);
  assert.equal(missingLength.ok, false);

  snapshotMode = "normal";
  snapshotUrlOverride = "https://example.com/api/chat/export?chatId=chat_1&format=snapshot";
  const untrustedSnapshot = await renderer.renderChatHtml("chat_1", origin);
  assert.equal(untrustedSnapshot.ok, false);
  snapshotUrlOverride = "";

  assert.ok(renderer.worker);
  await renderer.worker.terminate();
  const recovered = await renderer.renderChatHtml("chat_1", origin);
  assert.equal(recovered.ok, true);
  assert.equal(templateRequests, 2);
});

test("conversation snapshot freezes every manifest resource and rejects a changed artifact", async (t) => {
  const published = Buffer.from("<h1>报告</h1>");
  const pdf = Buffer.from("%PDF-1.7\nresource");
  const changed = Buffer.from("<h1>已修改</h1>");
  const expectedHash = createHash("sha256").update(published).digest("hex");
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  let served = published;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    assert.equal(req.headers.authorization, "Bearer desktop-token");
    if (url.pathname === "/api/chat/export") {
      const snapshot = Buffer.from(JSON.stringify({ version: 1, turns: [], attachments: [
        { id: "0123456789abcdef01234567", name: "报告.html", mimeType: "text/html",
          sourceRef: "artifacts/run-1/report.html", size: published.length, sha256: expectedHash },
        { id: "abcdef0123456789abcdef01", name: "报告.pdf", mimeType: "application/pdf",
          sourceRef: "artifacts/run-1/report.pdf", size: pdf.length, sha256: pdfHash }
      ] }));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": snapshot.length });
      res.end(snapshot);
      return;
    }
    if (url.pathname === "/api/resource") {
      const file = url.searchParams.get("file");
      if (file === "chat_1/artifacts/run-1/report.html") {
        assert.equal(req.headers.accept, "text/html");
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": served.length });
        res.end(served);
      } else {
        assert.equal(file, "chat_1/artifacts/run-1/report.pdf");
        assert.equal(req.headers.accept, "application/pdf");
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length });
        res.end(pdf);
      }
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
  const renderer = new ConversationHtmlRenderService({ snapshotProvider: {
    async createChatSnapshotRequest() {
      return { ok: true, snapshotUrl: `http://127.0.0.1:${address.port}/api/chat/export?chatId=chat_1&format=snapshot`,
        bearerToken: "desktop-token" };
    }
  } });
  renderer.start();
  t.after(() => renderer.dispose());

  const valid = await renderer.readChatSnapshot("chat_1");
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.attachments.map((item) => [item.name, item.mimeType]), [
    ["报告.html", "text/html"], ["报告.pdf", "application/pdf"]
  ]);
  assert.equal(Buffer.compare(valid.attachments[0].bytes, published), 0);
  assert.equal(Buffer.compare(valid.attachments[1].bytes, pdf), 0);

  served = changed;
  const invalid = await renderer.readChatSnapshot("chat_1");
  assert.equal(invalid.ok, false);
});

test("conversation snapshot rejects MIME, length, hash, duplicate, missing and aggregate-limit mismatches", async (t) => {
  const body = Buffer.from("data");
  const hash = createHash("sha256").update(body).digest("hex");
  const otherHash = createHash("sha256").update(Buffer.from("xxxx")).digest("hex");
  let scenario = "mime";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/chat/export") {
      const descriptor = {
        id: "0123456789abcdef01234567",
        name: "report.html",
        mimeType: "text/html",
        sourceRef: "artifacts/run-1/report.html",
        size: scenario === "length" ? body.length + 1 : body.length,
        sha256: scenario === "hash" ? otherHash : hash
      };
      let attachments = [descriptor];
      if (scenario === "duplicate") attachments = [descriptor, { ...descriptor, name: "duplicate.html" }];
      if (scenario === "missing") attachments = [descriptor, {
        ...descriptor,
        id: "abcdef0123456789abcdef01",
        name: "missing.html",
        sourceRef: "artifacts/run-1/missing.html"
      }];
      if (scenario === "limit") attachments = [{ ...descriptor, size: 20 * 1024 * 1024 + 1 }];
      const snapshot = Buffer.from(JSON.stringify({ version: 1, turns: [], attachments }));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": snapshot.length });
      res.end(snapshot);
      return;
    }
    if (url.pathname === "/api/resource") {
      if (url.searchParams.get("file")?.endsWith("/missing.html")) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (scenario === "limit") {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": 20 * 1024 * 1024 + 1 });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": scenario === "mime" ? "application/pdf" : "text/html",
        "Content-Length": body.length
      });
      res.end(body);
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
  const renderer = new ConversationHtmlRenderService({ snapshotProvider: {
    async createChatSnapshotRequest() {
      return {
        ok: true,
        snapshotUrl: `http://127.0.0.1:${address.port}/api/chat/export?chatId=chat_1&format=snapshot`,
        bearerToken: "desktop-token"
      };
    }
  } });
  renderer.start();
  t.after(() => renderer.dispose());

  for (scenario of ["mime", "length", "hash", "duplicate", "missing", "limit"]) {
    const result = await renderer.readChatSnapshot("chat_1");
    assert.equal(result.ok, false, scenario);
  }
});
