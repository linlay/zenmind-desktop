import test from "node:test";
import assert from "node:assert/strict";

const {
  customSidebarItemMatchesSurfaceTarget,
  normalizeSurfaceMatchText
} = await import("../dist-electron/main/browser-surface-registry.js");

test("browser surface registry normalizes URLs and labels for fuzzy activation", () => {
  assert.equal(normalizeSurfaceMatchText(" https://www.Example.test/path/// "), "example.test/path");
  assert.equal(normalizeSurfaceMatchText("www.Example.test"), "example.test");
});

test("browser surface registry matches custom sidebar surfaces by id label url or host", () => {
  const surface = {
    id: "docs",
    label: "Product Docs",
    url: "https://docs.example.test/guide",
    active: false
  };

  assert.equal(customSidebarItemMatchesSurfaceTarget(surface, "docs"), true);
  assert.equal(customSidebarItemMatchesSurfaceTarget(surface, "product"), true);
  assert.equal(customSidebarItemMatchesSurfaceTarget(surface, "docs.example.test"), true);
  assert.equal(customSidebarItemMatchesSurfaceTarget(surface, "missing"), false);
});
