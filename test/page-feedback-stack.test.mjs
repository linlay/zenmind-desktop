import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("page feedback escapes caller layout and paint containment through a portal", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src/renderer/components/PageFeedbackStack.tsx"),
    "utf8",
  );

  assert.match(source, /import \{ createPortal \} from "react-dom";/u);
  assert.match(source, /createPortal\(feedbackStack, document\.body\)/u);
});
