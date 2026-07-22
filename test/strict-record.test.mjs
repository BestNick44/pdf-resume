import assert from "node:assert/strict";
import test from "node:test";

import { isPlainObject, randomHexId } from "../shared/strict-record.mjs";

test("isPlainObject accepts ordinary and null-prototype objects", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
});

test("isPlainObject rejects non-plain values", () => {
  class Example {}

  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Example()), false);
  assert.equal(isPlainObject(Object.create({})), false);
});

test("randomHexId returns a 128-bit lowercase hexadecimal ID", () => {
  assert.match(randomHexId("crypto unavailable"), /^[0-9a-f]{32}$/);
});

test("randomHexId throws the provided message when crypto is absent", () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });

  try {
    assert.throws(
      () => randomHexId("custom unavailable message"),
      new Error("custom unavailable message"),
    );
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }
});
