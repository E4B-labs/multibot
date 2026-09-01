// multibot: pigułki w transkrypcie wyprowadzamy z samej treści wiadomości, więc
// pomyłka parsera ukrywa prawdziwą wiadomość użytkownika. Stąd ten test.
import { describe, expect, it } from "vitest";

import { routineStartName, slashCommandLabel } from "./transcriptChips";

describe("routineStartName", () => {
  it("wyciąga nazwę z prefiksu, którym przelotka poprzedza prompt rutyny", () => {
    expect(routineStartName("[Routine: Weekly agent updates]\n\nZrób raport")).toBe("Weekly agent updates");
  });

  it("zwykła wiadomość i pusta treść nie są startem rutyny", () => {
    expect(routineStartName("Kiedy startuje [Routine: X]?")).toBeNull();
    expect(routineStartName(undefined)).toBeNull();
  });
});

describe("slashCommandLabel", () => {
  it("sama komenda staje się czytelną etykietą", () => {
    expect(slashCommandLabel("/learn-from-demonstration")).toBe("Learn from demonstration");
    expect(slashCommandLabel("/model")).toBe("Model");
  });

  it("komenda z argumentami zostaje treścią, nie pigułką", () => {
    expect(slashCommandLabel("/model opus")).toBeNull();
    expect(slashCommandLabel("zwykły tekst")).toBeNull();
    expect(slashCommandLabel("/")).toBeNull();
  });
});
