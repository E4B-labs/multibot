// Self-check for host-resolve.mjs. Zero dependencies:
// `node electron/host-resolve.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeRemoteUrl, removeRemoteHost, resolveActiveTarget, upsertRemoteHost } from "./host-resolve.mjs";

test("normalizeRemoteUrl strips trailing slashes and validates scheme", () => {
  assert.equal(normalizeRemoteUrl("https://host.ts.net/"), "https://host.ts.net");
  assert.equal(normalizeRemoteUrl(" http://127.0.0.1:8799// "), "http://127.0.0.1:8799");
  assert.throws(() => normalizeRemoteUrl("not-a-url"));
  assert.throws(() => normalizeRemoteUrl(""));
});

test("upsertRemoteHost replaces by id and keeps newest first", () => {
  const a = { id: "a", name: "A", url: "https://a" };
  const b = { id: "b", name: "B", url: "https://b" };
  const list = upsertRemoteHost([a], b);
  assert.deepEqual(list, [b, a]);

  const a2 = { id: "a", name: "A2", url: "https://a2" };
  const replaced = upsertRemoteHost(list, a2);
  assert.deepEqual(replaced, [a2, b]);
});

test("removeRemoteHost drops only the matching id", () => {
  const hosts = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(removeRemoteHost(hosts, "a"), [{ id: "b" }]);
});

test("resolveActiveTarget: missing config, activeId=local, or dangling id => local", () => {
  assert.deepEqual(resolveActiveTarget(null), { mode: "local" });
  assert.deepEqual(resolveActiveTarget({ activeId: "local", hosts: [] }), { mode: "local" });
  assert.deepEqual(resolveActiveTarget({ activeId: "missing", hosts: [] }), { mode: "local" });
});

test("resolveActiveTarget: known remote id => that host", () => {
  const host = { id: "h1", url: "https://h1" };
  assert.deepEqual(resolveActiveTarget({ activeId: "h1", hosts: [host] }), { mode: "remote", host });
});
