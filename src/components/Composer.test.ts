// multibot: paleta "/" — jedyna nietrywialna logika listy to filtr z limitem
// na kategorię. Bez limitu akcje i skille zjadają całą listę i wtyczki, agenci
// ani rutyny nigdy się nie pokazują, więc ten test pilnuje właśnie tego.
import { describe, expect, it } from "vitest";

import { fastModeAvailable, reasoningLevels, slashVisible, withCommand, type SlashRow } from "./Composer";

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

// multibot: wstawianie komendy z palety poleceń. Nietrywialna jest jedna
// decyzja — co zrobić z tekstem, który już jest w composerze.
describe("withCommand", () => {
  it("zachowuje niedokończoną treść jako argumenty komendy", () => {
    expect(withCommand("raport za marzec", "/model")).toBe("/model raport za marzec");
  });

  it("podmienia komendę, gdy treść już nią jest", () => {
    expect(withCommand("/szukaj", "/model")).toBe("/model ");
  });

  it("na pustym composerze zostawia spację na argumenty", () => {
    expect(withCommand("   ", "/model")).toBe("/model ");
  });
});

// multibot: poziom "max" przyjmuje tylko linia 5.6 i GPT-6 Astra; reszta
// dostałaby od CLI błąd, więc lista musi go dla nich uciąć.
describe("reasoningLevels", () => {
  const ids = (model: string) => reasoningLevels(model).map((level) => level.id);

  it("daje max dla gpt-6-astra", () => {
    expect(ids("gpt-6-astra")).toContain("max");
  });

  it("daje max dla linii 5.6", () => {
    expect(ids("gpt-5.6-sol")).toContain("max");
  });

  it("tnie max starszym modelom", () => {
    expect(ids("gpt-5.4")).not.toContain("max");
  });

  it("dla haiku zostawia sam domyślny poziom", () => {
    expect(ids("claude-haiku-4-5")).toEqual(["default"]);
  });
});

// multibot: „Fast mode" (service tier `priority`) ma tylko codex — przełącznik
// pokazany przy Claude czy silniku byłby atrapą, bo te drivery go nie wysyłają.
describe("fastModeAvailable", () => {
  it("daje przełącznik modelom codeksa", () => {
    expect(fastModeAvailable("codex", "gpt-5.6-sol")).toBe(true);
    expect(fastModeAvailable("codex", "gpt-5.5")).toBe(true);
  });

  it("chowa go dla gpt-5.4-mini, który nie ma tieru priority", () => {
    expect(fastModeAvailable("codex", "gpt-5.4-mini")).toBe(false);
  });

  it("chowa go poza codeksem", () => {
    expect(fastModeAvailable("claude", "claude-sonnet-5")).toBe(false);
    expect(fastModeAvailable("slafy", "hermes-agent")).toBe(false);
    expect(fastModeAvailable(undefined, "gpt-5.6-sol")).toBe(false);
  });
});
