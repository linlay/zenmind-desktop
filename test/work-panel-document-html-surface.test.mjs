import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("native WorkPanel HTML stays a full-size preview with annotation-only editing", () => {
  const surface = read("src/renderer/work-panel/WorkPanelDocumentHtml.tsx");
  const reviewScript = read("src/renderer/work-panel/work-panel-document-html-review.js").trim();
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const css = read("src/renderer/styles/app-shell.css");
  const rendererIndex = read("index.html");
  const brandArtifacts = read("scripts/lib/brand-artifacts.mjs");
  const reviewScriptCspSource = `'sha256-${createHash("sha256").update(reviewScript).digest("base64")}'`;

  assert.doesNotMatch(surface, /\bSegmented\b|type ViewMode|documentHtml\.commit/u);
  assert.doesNotMatch(
    surface,
    /chatWorkPanel\.document\.(?:source|preview|split|overwriteArtifact|save|saveNewArtifact)/u,
  );
  assert.match(surface, /annotating \? " is-annotating" : ""/u);
  assert.match(surface, /chatWorkPanel\.review\.returnPreview/u);
  assert.doesNotMatch(surface, /ArrowLeftOutlined/u);
  assert.match(surface, /ReloadOutlined/u);
  assert.match(surface, /chatWorkPanel\.review\.panel/u);
  assert.match(surface, /className="work-panel-document-html-location" title=\{displayUrl\}/u);
  assert.match(surface, /new URL\(displayUrl\)[\s\S]*?url\.pathname[\s\S]*?value=\{displayPath\}/u);
  assert.match(surface, /onFocus=\{\(event\) => event\.currentTarget\.select\(\)\}/u);
  assert.match(surface, /onCopy=\{\(event\)[\s\S]*?clipboardData\.setData\("text\/plain", displayUrl\)/u);
  assert.doesNotMatch(surface, /<span>\{displayUrl\}<\/span>/u);
  assert.match(surface, /chatWorkPanel\.review\.annotationCount[\s\S]{0,100}?annotations\.length/u);
  assert.match(surface, /<Popover[\s\S]*?className="work-panel-document-html-count"/u);
  assert.match(surface, /<Modal[\s\S]*?chatWorkPanel\.document\.addAnnotation[\s\S]*?Input\.TextArea/u);
  assert.match(surface, /okButtonProps=\{\{ disabled: !pendingNote\.trim\(\) \}\}/u);
  assert.match(surface, /setPendingAnnotation[\s\S]*?confirmPendingAnnotation/u);
  assert.match(surface, /zenmind-html-annotation-mode/u);
  assert.match(surface, /work-panel-document-html-review\.js\?raw/u);
  assert.match(surface, /data-zenmind-review-token/u);
  assert.match(reviewScript, /document\.currentScript/u);
  assert.match(reviewScript, /addEventListener\("pointermove"[\s\S]*?addEventListener\("pointerdown"[\s\S]*?addEventListener\("pointerup"/u);
  assert.match(reviewScript, /stopImmediatePropagation/u);
  assert.match(reviewScript, /elementsFromPoint/u);
  assert.match(reviewScript, /zenmindReviewMarker/u);
  assert.match(rendererIndex, /script-src 'self'/u);
  assert.ok(rendererIndex.includes(reviewScriptCspSource));
  assert.ok(brandArtifacts.includes(reviewScriptCspSource));
  assert.doesNotMatch(surface, /allow-same-origin/u);
  assert.match(surface, /onHandoff\(annotations\.filter/u);
  assert.match(surface, /data-work-panel-document-dirty=\{annotations\.length > 0/u);
  assert.doesNotMatch(host, /<WorkPanelDocumentHtml[\s\S]{0,500}?onCommitted=/u);

  assert.match(
    css,
    /\.work-panel-document-html\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?display:\s*flex;/u,
  );
  assert.match(
    css,
    /\.work-panel-document-html-body\s*>\s*iframe\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?height:\s*100%;/u,
  );
});
