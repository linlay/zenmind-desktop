import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getAvailableFilePath,
  getDesktopDownloadDefaultPath
} = require("../dist-electron/main/download-paths.js");

test("Desktop Downloads paths use native macOS and Windows separators", () => {
  const darwinApp = {
    getPath(name) {
      assert.equal(name, "downloads");
      return "/Users/poster/Downloads";
    }
  };
  const windowsApp = {
    getPath(name) {
      assert.equal(name, "downloads");
      return "C:\\Users\\poster\\Downloads";
    }
  };

  assert.equal(
    getDesktopDownloadDefaultPath(darwinApp, "海报.html", "darwin"),
    "/Users/poster/Downloads/海报.html"
  );
  assert.equal(
    getDesktopDownloadDefaultPath(windowsApp, "海报.html", "win32"),
    "C:\\Users\\poster\\Downloads\\海报.html"
  );
});

test("collision numbering is deterministic on macOS and Windows paths", async () => {
  const existing = new Set([
    "/Users/poster/Downloads/海报.png",
    "C:\\Users\\poster\\Downloads\\海报.png"
  ]);
  const fsAccess = async (candidate) => {
    if (!existing.has(candidate)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };

  assert.equal(
    await getAvailableFilePath("/Users/poster/Downloads/海报.png", { platform: "darwin", fsAccess }),
    "/Users/poster/Downloads/海报 (1).png"
  );
  assert.equal(
    await getAvailableFilePath("C:\\Users\\poster\\Downloads\\海报.png", { platform: "win32", fsAccess }),
    "C:\\Users\\poster\\Downloads\\海报 (1).png"
  );
});
