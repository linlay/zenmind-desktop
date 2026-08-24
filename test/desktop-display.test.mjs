import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DESKTOP_DISPLAY_DEFAULT_DURATION_MS,
  validateDesktopDisplayPayload,
} = require("../dist-electron/shared/desktop-display.js");
const {
  DESKTOP_ACTION_DEFINITIONS,
} = require("../dist-electron/shared/desktop-actions.js");

test("desktop.display accepts all three effects and applies the default duration", () => {
  for (const effect of ["fireworks", "snowfall", "nationalDay"]) {
    assert.deepEqual(validateDesktopDisplayPayload({ kind: "effect", effect }), {
      ok: true,
      value: { kind: "effect", effect, durationMs: DESKTOP_DISPLAY_DEFAULT_DURATION_MS },
    });
  }
  assert.deepEqual(
    DESKTOP_ACTION_DEFINITIONS.find((definition) => definition.name === "desktop.display"),
    {
      name: "desktop.display",
      kind: "execute",
      category: "display",
      confirmation: "none",
      description: "Show a transient effect in the Desktop Main Window. Args: { kind: effect, effect: fireworks|snowfall|nationalDay, durationMs? }.",
    },
  );
});

test("desktop.display validates exact fields and duration bounds", () => {
  for (const durationMs of [1_000, 30_000]) {
    assert.deepEqual(validateDesktopDisplayPayload({ kind: "effect", effect: "fireworks", durationMs }), {
      ok: true,
      value: { kind: "effect", effect: "fireworks", durationMs },
    });
  }
  for (const payload of [
    { kind: "other", effect: "fireworks" },
    { kind: "effect", effect: "unknown" },
    { kind: "effect", effect: "fireworks", durationMs: 999 },
    { kind: "effect", effect: "fireworks", durationMs: 30_001 },
    { kind: "effect", effect: "fireworks", durationMs: 1_500.5 },
    { kind: "effect", effect: "fireworks", extra: true },
  ]) {
    assert.equal(validateDesktopDisplayPayload(payload).ok, false, JSON.stringify(payload));
  }
});
