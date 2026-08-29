// Self-check preferencji akceleracji sprzętowej:
// `node --test electron/hardware-acceleration.test.mjs`.
//
// Pilnuje jednej rzeczy, która jest łatwa do odwrócenia przez pomyłkę:
// domyślnie akceleracja ma być WYŁĄCZONA. Electron włącza ją sam, więc każdy
// przypadek „nie wiem" — brak pliku, śmieci, zły typ — musi kończyć się
// wyłączeniem, inaczej pierwsze uruchomienie zachowa się odwrotnie niż panel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULT_ENABLED, parseHardwareAcceleration, withHardwareAcceleration } =
  require("./hardware-acceleration.cjs");

test("domyślnie wyłączona", () => {
  assert.equal(DEFAULT_ENABLED, false);
});

test("brak pliku, śmieci i zły typ dają wyłączoną", () => {
  assert.equal(parseHardwareAcceleration(undefined), false);
  assert.equal(parseHardwareAcceleration(""), false);
  assert.equal(parseHardwareAcceleration("{niepoprawny json"), false);
  assert.equal(parseHardwareAcceleration("null"), false);
  assert.equal(parseHardwareAcceleration("[]"), false);
  assert.equal(parseHardwareAcceleration("{}"), false);
});

test("włącza wyłącznie jawne true, nie wartości prawdziwe „mniej więcej”", () => {
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":true}'), true);
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":false}'), false);
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":"true"}'), false);
  assert.equal(parseHardwareAcceleration('{"hardwareAcceleration":1}'), false);
});

test("zapis nie kasuje innych preferencji z pliku", () => {
  const next = withHardwareAcceleration('{"cosInnego":42}', true);
  assert.deepEqual(next, { cosInnego: 42, hardwareAcceleration: true });
});

test("zapis na uszkodzonym pliku zaczyna od czystego obiektu", () => {
  assert.deepEqual(withHardwareAcceleration("{zepsute", true), { hardwareAcceleration: true });
  assert.deepEqual(withHardwareAcceleration(undefined, false), { hardwareAcceleration: false });
});
