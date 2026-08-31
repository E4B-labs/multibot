// Self-check for the Electron hardware acceleration preference.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_ENABLED, parseHardwareAcceleration, withHardwareAcceleration } =
  require("./hardware-acceleration.cjs");

test("hardware acceleration is enabled by default", () => {
  assert.equal(DEFAULT_ENABLED, true);
});

test("missing and malformed data fall back to the enabled mode", () => {
  assert.equal(parseHardwareAcceleration(undefined), true);
  assert.equal(parseHardwareAcceleration(""), true);
  assert.equal(parseHardwareAcceleration("{invalid json"), true);
  assert.equal(parseHardwareAcceleration("null"), true);
  assert.equal(parseHardwareAcceleration("[]"), true);
  assert.equal(parseHardwareAcceleration("{}"), true);
});

test("only an explicit true enables the preference", () => {
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":true}'), true);
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":false}'), false);
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":"true"}'), false);
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":1}'), false);
});

test("writing the preference preserves other settings", () => {
  assert.deepEqual(withHardwareAcceleration('{"other":42}', true), { other: 42, hardwareAcceleration: true });
});

test("writing a malformed preference starts with a clean object", () => {
  assert.deepEqual(withHardwareAcceleration("{invalid", true), { hardwareAcceleration: true });
  assert.deepEqual(withHardwareAcceleration(undefined, false), { hardwareAcceleration: false });
});
