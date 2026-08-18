// multibot: paleta "/" — jedyna nietrywialna logika listy to filtr z limitem
// na kategorię. Bez limitu akcje i skille zjadają całą listę i wtyczki, agenci
// ani rutyny nigdy się nie pokazują, więc ten test pilnuje właśnie tego.
import { describe, expect, it } from "vitest";

import { slashVisible, type SlashRow } from "./Composer";

const row = (kind: SlashRow["kind"], label: string): SlashRow => ({
  id: `${kind}-${label}`,
  label,
  hint: "",
  kind,
});

describe("slashVisible", () => {
  const many: SlashRow[] = [
    ...Array.from({ length: 9 }, (_, i) => row("action", `action-${i}`)),
    row("plugin", "Gmail"),
    row("agent", "Scout"),
    row("routine", "Weekly digest"),
  ];

  it("pokazuje każdą kategorię mimo długiej listy akcji", () => {
    const kinds = new Set(slashVisible(many, "").map((r) => r.kind));
    expect(kinds).toEqual(new Set(["action", "plugin", "agent", "routine"]));
  });

  it("tnie jedną kategorię do pięciu wierszy", () => {
    expect(slashVisible(many, "").filter((r) => r.kind === "action")).toHaveLength(5);
  });

  it("trzyma stałą kolejność kategorii", () => {
    const rows = slashVisible([row("routine", "r"), row("skill", "/s"), row("action", "a")], "");
    expect(rows.map((r) => r.kind)).toEqual(["action", "skill", "routine"]);
  });

  it("dopasowuje skille bez wiodącego ukośnika", () => {
    expect(slashVisible([row("skill", "/add-connector")], "add").map((r) => r.label)).toEqual(["/add-connector"]);
  });

  it("puste zapytanie nie filtruje niczego", () => {
    expect(slashVisible([row("agent", "Scout")], "")).toHaveLength(1);
  });
});
