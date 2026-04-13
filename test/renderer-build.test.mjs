import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

test("renderer entry uses HashRouter for Electron routing", () => {
  const rendererEntry = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "main.tsx"),
    "utf8"
  );

  assert.match(rendererEntry, /HashRouter/);
  assert.doesNotMatch(rendererEntry, /BrowserRouter/);
});

test("built index uses relative asset paths", () => {
  const builtIndex = fs.readFileSync(path.join(projectRoot, "dist-renderer", "index.html"), "utf8");

  assert.doesNotMatch(builtIndex, /src="\/assets\//);
  assert.doesNotMatch(builtIndex, /href="\/assets\//);
  assert.match(builtIndex, /(src|href)="\.?\/?assets\//);
});
