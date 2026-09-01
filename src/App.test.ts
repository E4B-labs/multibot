import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Panel „Server & devices" został usunięty z UI razem ze stanem otwierania.
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("usunięty panel Server & devices", () => {
  it("nie renderuje panelu ani nie importuje jego komponentu", () => {
    expect(app).not.toContain("ServerAccessPanel");
    expect(app).not.toContain("serverAccessOpen");
  });
});
