import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DESKTOP_WEBSITE_FAVICON_PROTOCOL } = require("../dist-electron/shared/website-favicon.js");
const {
  cacheWebsiteFavicon,
  findCachedWebsiteFaviconPath,
  __testInternals,
} = require("../dist-electron/main/modules/webs/websites/favicon-cache.js");
const {
  isWebsiteFaviconPathInsideRoot,
  resolveWebsiteFaviconRequest,
} = require("../dist-electron/main/modules/webs/websites/favicon-protocol.js");
const { updateWebsiteItem } = require("../dist-electron/main/modules/webs/websites/actions.js");
const { getWebsiteDir } = require("../dist-electron/main/modules/webs/websites/store.js");

function createApp(root) {
  return {
    getPath(name) {
      if (name === "home") return path.join(root, "home");
      if (name === "appData") return path.join(root, "app-data");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      throw new Error(`unexpected app.getPath(${name})`);
    },
  };
}

function writeWebsite(app, id = "docs", url = "https://docs.example.com/") {
  const websiteDir = getWebsiteDir(app, id);
  fs.mkdirSync(websiteDir, { recursive: true });
  fs.writeFileSync(path.join(websiteDir, "website.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    kind: "website",
    label: "Docs",
    url,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");
  return websiteDir;
}

function response({ status = 200, contentType = "image/png", contentLength = "", bytes = Buffer.from([1, 2, 3]) } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://cdn.example.com/favicon.png",
    headers: {
      get(name) {
        if (name === "content-type") return contentType;
        if (name === "content-length") return contentLength;
        return null;
      },
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("website favicon cache stores a validated icon and serves it only through the local protocol", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-website-favicon-"));
  try {
    const app = createApp(root);
    const websiteDir = writeWebsite(app);
    const iconBytes = Buffer.from([137, 80, 78, 71]);
    const result = await cacheWebsiteFavicon(app, {
      id: "docs",
      websiteUrl: "https://docs.example.com/",
      faviconUrl: "https://cdn.example.com/favicon.png",
    }, {
      fetchImpl: async () => response({ bytes: iconBytes }),
    });

    assert.equal(result.ok, true);
    assert.match(result.faviconUrl, new RegExp(`^${DESKTOP_WEBSITE_FAVICON_PROTOCOL}://docs/favicon\\?v=`, "u"));
    const cachePath = path.join(websiteDir, "favicon.png");
    assert.deepEqual(fs.readFileSync(cachePath), iconBytes);
    assert.equal(findCachedWebsiteFaviconPath(app, "docs"), cachePath);
    assert.equal(
      resolveWebsiteFaviconRequest(app, result.faviconUrl),
      fs.realpathSync.native(cachePath),
    );
    assert.equal(
      resolveWebsiteFaviconRequest(app, `${DESKTOP_WEBSITE_FAVICON_PROTOCOL}://docs/website.json`),
      "",
    );

    const outsidePath = path.join(root, "outside.png");
    fs.writeFileSync(outsidePath, "outside", "utf8");
    fs.rmSync(cachePath);
    fs.symlinkSync(outsidePath, cachePath);
    assert.equal(resolveWebsiteFaviconRequest(app, result.faviconUrl), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("website favicon cache rejects invalid, oversized, non-image, and timed out responses without replacing the old cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-website-favicon-failure-"));
  try {
    const app = createApp(root);
    const websiteDir = writeWebsite(app);
    const cachePath = path.join(websiteDir, "favicon.png");
    const oldIcon = Buffer.from([1, 2, 3]);
    fs.writeFileSync(cachePath, oldIcon);
    const input = {
      id: "docs",
      websiteUrl: "https://docs.example.com/",
      faviconUrl: "https://cdn.example.com/favicon.png",
    };

    assert.equal((await cacheWebsiteFavicon(app, { ...input, faviconUrl: "file:///tmp/favicon.png" })).ok, false);
    assert.equal((await cacheWebsiteFavicon(app, input, {
      fetchImpl: async () => response({ contentType: "text/html" }),
    })).ok, false);
    assert.equal((await cacheWebsiteFavicon(app, input, {
      fetchImpl: async () => response({ contentLength: String(__testInternals.FAVICON_MAX_BYTES + 1) }),
    })).ok, false);
    assert.equal((await cacheWebsiteFavicon(app, input, {
      fetchImpl: async () => response({ bytes: Buffer.alloc(__testInternals.FAVICON_MAX_BYTES + 1) }),
    })).ok, false);
    assert.equal((await cacheWebsiteFavicon(app, input, {
      timeoutMs: 1,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
      }),
    })).ok, false);
    assert.deepEqual(fs.readFileSync(cachePath), oldIcon);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("website favicon cache accepts safe data images and clears the cache when the configured URL changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-website-favicon-update-"));
  try {
    const app = createApp(root);
    const websiteDir = writeWebsite(app);
    const result = await cacheWebsiteFavicon(app, {
      id: "docs",
      websiteUrl: "https://docs.example.com/",
      faviconUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(websiteDir, "favicon.png")), true);

    const updated = updateWebsiteItem(app, "docs", { url: "https://new-docs.example.com/" });
    assert.equal(updated.ok, true);
    assert.equal(fs.existsSync(path.join(websiteDir, "favicon.png")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("website favicon protocol containment honors macOS and Windows paths", () => {
  assert.equal(
    isWebsiteFaviconPathInsideRoot(
      "/Users/lin/.zenmind/.desktop/data/webs/websites/docs",
      "/Users/lin/.zenmind/.desktop/data/webs/websites/docs/favicon.png",
      "darwin",
    ),
    true,
  );
  assert.equal(
    isWebsiteFaviconPathInsideRoot(
      "C:\\Users\\Lin\\.zenmind\\.desktop\\data\\webs\\websites\\docs",
      "C:\\Users\\Lin\\.zenmind\\.desktop\\data\\webs\\websites\\other\\favicon.png",
      "win32",
    ),
    false,
  );
});
