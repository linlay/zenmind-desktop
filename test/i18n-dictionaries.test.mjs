import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("i18n dictionaries are complete and placeholders match", () => {
  const output = execFileSync("node", ["./scripts/i18n/validate-dictionaries.mjs"], {
    encoding: "utf8"
  });
  assert.match(output, /validated \d+ i18n keys/);
});
