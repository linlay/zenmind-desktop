import test from "node:test";
import assert from "node:assert/strict";
import { isDocumentResourcePath } from "../dist-electron/main/modules/work-panel/document-html-preview.js";

test("a root HTML Reference may read itself without gaining access to sibling Chat files", () => {
  const document = { source: { kind: "reference" }, semanticPath: "申请表.html" };
  assert.equal(isDocumentResourcePath(document, "申请表.html"), true);
  for (const path of ["messages.json", "other.html", "references/image.png", "../申请表.html", "artifacts/run/index.html"]) {
    assert.equal(isDocumentResourcePath(document, path), false);
  }
});
