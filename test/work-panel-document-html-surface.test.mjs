import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("native WorkPanel HTML stays a full-size preview with annotation-only editing", () => {
  const surface = read("src/renderer/work-panel/WorkPanelDocumentHtml.tsx");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const css = read("src/renderer/styles/app-shell.css");

  assert.doesNotMatch(surface, /\bSegmented\b|type ViewMode|documentHtml\.commit|Input\.TextArea/u);
  assert.doesNotMatch(
    surface,
    /chatWorkPanel\.document\.(?:source|preview|split|overwriteArtifact|save|saveNewArtifact)/u,
  );
  assert.match(surface, /annotating \? " is-annotating" : ""/u);
  assert.match(surface, /chatWorkPanel\.image\.done/u);
  assert.match(surface, /chatWorkPanel\.review\.panel/u);
  assert.match(surface, /className="work-panel-document-html-location" title=\{displayUrl\}/u);
  assert.match(surface, /chatWorkPanel\.review\.annotationCount[\s\S]{0,100}?annotations\.length/u);
  assert.match(surface, /zenmind-html-annotation-mode/u);
  assert.match(surface, /addEventListener\('pointermove'[\s\S]*?addEventListener\('pointerdown'[\s\S]*?addEventListener\('pointerup'/u);
  assert.match(surface, /stopImmediatePropagation/u);
  assert.match(surface, /elementsFromPoint/u);
  assert.match(surface, /zenmindReviewMarker/u);
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
