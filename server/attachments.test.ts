import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentStore, MAX_IMAGE_BYTES, resolveBotFile } from "./attachments.ts";

const roots: string[] = [];
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "multibot-attachments-"));
  roots.push(root);
  return { root, store: new AttachmentStore(root) };
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

// Regresja: bot zapisywal plik wlasna powloka, a potem probowal wepchnac go
// base64-em przez jej wyjscie. Przy trzydziestu kilobajtach wyjscie sie ucinalo
// i plik nigdy nie docieral. Teraz bot podaje sciezke ze swojego swiata, a
// harness ma ja umiec znalezc u siebie.
describe("resolveBotFile", () => {
  it("finds a file under a configured bot filesystem root", () => {
    const root = mkdtempSync(join(tmpdir(), "multibot-botfs-"));
    mkdirSync(join(root, "root"), { recursive: true });
    writeFileSync(join(root, "root", "report.html"), "<h1>hi</h1>");

    // Bot widzi `/root/report.html`; harness ma ten plik pod korzeniem kontenera.
    expect(resolveBotFile("/root/report.html", root)).toBe(resolve(root, "root", "report.html"));
    rmSync(root, { recursive: true, force: true });
  });

  it("says where it looked when the file is nowhere", () => {
    expect(() => resolveBotFile("/root/nie-ma.html", "/tmp/pusty-korzen")).toThrow(/no such file/);
  });

  it("rejects an empty path instead of resolving to the working directory", () => {
    expect(() => resolveBotFile("   ")).toThrow(/path required/);
  });
});

describe("attachment store", () => {
  it("persists metadata, enforces ownership and deletes files with bot", () => {
    const { root, store } = make();
    const file = store.add("bot-a", "photo.png", "image/png", Buffer.from("png"));
    expect(store.resolve("bot-a", file.id)).toMatchObject(file);
    expect(() => store.resolve("bot-b", file.id)).toThrow(/no such attachment/);
    expect(new AttachmentStore(root).resolve("bot-a", file.id)).toMatchObject(file);
    store.deleteBot("bot-a");
    expect(existsSync(join(root, "bot-a"))).toBe(false);
  });

  it("rejects traversal, duplicate ids, count and image size limits", () => {
    const { store } = make();
    expect(() => store.add("bot", "../secret", "text/plain", Buffer.from("x"))).toThrow(/invalid file name/);
    expect(() => store.add("bot", "large.png", "image/png", Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(/8 MB/);
    const file = store.add("bot", "one.txt", "text/plain", Buffer.from("x"));
    expect(() => store.resolveMany("bot", [file.id, file.id])).toThrow(/invalid attachment ids/);
    expect(() => store.resolveMany("bot", Array.from({ length: 11 }, () => crypto.randomUUID()))).toThrow(/maximum 10/);
  });
});
