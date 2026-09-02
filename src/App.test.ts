import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loginSwitch, loginTitle } from "./App";

// Panel „Server & devices" został usunięty z UI razem ze stanem otwierania.
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("usunięty panel Server & devices", () => {
  it("nie renderuje panelu ani nie importuje jego komponentu", () => {
    expect(app).not.toContain("ServerAccessPanel");
    expect(app).not.toContain("serverAccessOpen");
  });
});

// Ekranu logowania nie da się tu wyrenderować: vitest chodzi w środowisku node,
// repo nie ma jsdom i nie dokładamy zależności dla jednej asercji (tak samo jak
// w WindowControls.test.ts). Nagłówek i stopka idą więc z czystych funkcji, a
// one dają się sprawdzić wprost; przy przycisku „Wstecz" chodzi o sam warunek
// renderowania, więc pilnujemy go w źródle.
describe("ekran logowania: nagłówek", () => {
  it("idzie z trybu, a nie ze stanu serwera", () => {
    expect(loginTitle("host", false)).toBe("Create server");
    expect(loginTitle("register", false)).toBe("Join existing server");
    expect(loginTitle("login", false)).toBe("Sign in to server");
    expect(loginTitle("recover", false)).toBe("Recover account");
    expect(loginTitle("legacy", false)).toBe("Legacy migration");
  });

  it("mówi po polsku w każdym trybie", () => {
    expect(loginTitle("host", true)).toBe("Utwórz serwer");
    expect(loginTitle("register", true)).toBe("Dołącz do istniejącego serwera");
    expect(loginTitle("login", true)).toBe("Zaloguj się do serwera");
    expect(loginTitle("recover", true)).toBe("Odzyskaj konto");
    expect(loginTitle("legacy", true)).toBe("Migracja starego tokenu");
  });
});

describe("ekran logowania: przełącznik trybu w stopce", () => {
  it("na nieskonfigurowanym serwerze prowadzi w obie strony", () => {
    expect(loginSwitch("host", false, false)).toEqual({ next: "register", label: "Join existing server" });
    expect(loginSwitch("register", false, false)).toEqual({ next: "host", label: "Create server" });
  });

  it("na skonfigurowanym zostawia przełączanie logowanie/profil", () => {
    expect(loginSwitch("login", true, false)).toEqual({ next: "register", label: "Create profile" });
    expect(loginSwitch("register", true, false)).toEqual({ next: "login", label: "I have an account" });
    expect(loginSwitch("recover", true, false)).toEqual({ next: "login", label: "I have an account" });
  });

  it("milczy przy migracji starego tokenu", () => {
    expect(loginSwitch("legacy", false, false)).toBeNull();
    expect(loginSwitch("legacy", true, false)).toBeNull();
  });
});

describe("ekran logowania: przycisk Wstecz i stary token", () => {
  it("Wstecz rysuje się tylko z mostkiem desktopowym, bez pozornego history.back()", () => {
    expect(app).not.toContain("window.history.back()");
    expect(app).toContain("{backToHostPicker && <button");
  });

  it("stary token ma pod polem napisane, czym jest", () => {
    expect(app).toContain("auth.token");
  });
});
