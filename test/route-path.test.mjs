import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  decodeRoutePathSegment,
  encodeRoutePathSegment
} = require("../dist-electron/shared/route-path.js");

test("route path segments decode once and encode semantic values once", () => {
  for (const value of ["AI建设文档", "冒烟文档", "cutej", "100%助手", "包含 空格", "目录/助理"]) {
    const encoded = encodeRoutePathSegment(value);
    assert.equal(decodeRoutePathSegment(encoded), value);
    assert.equal(encodeRoutePathSegment(decodeRoutePathSegment(encoded)), encoded);
  }
});

test("route path segment decoding rejects empty and malformed values", () => {
  assert.equal(decodeRoutePathSegment(""), null);
  assert.equal(decodeRoutePathSegment("   "), null);
  assert.equal(decodeRoutePathSegment("%E5%A"), null);
  assert.equal(decodeRoutePathSegment("%"), null);
});

test("route path segment decoding never recursively decodes literal percent values", () => {
  const semanticValue = "100%助手";
  const encoded = encodeRoutePathSegment(semanticValue);

  assert.match(encoded, /^100%25/u);
  assert.equal(decodeRoutePathSegment(encoded), semanticValue);
  assert.equal(decodeRoutePathSegment(encodeRoutePathSegment(encoded)), encoded);
});
