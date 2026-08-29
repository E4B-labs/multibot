import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: „Serwer i urządzenia" nie otwierało się z ustawień (zgłoszone
// 29.08). Panel to modal na całą powłokę, ale renderował się w gałęzi
// „ustawienia zamknięte" tego samego rozgałęzienia, które przy otwartych
// ustawieniach pokazuje AppSettingsPanel. A otwiera go przycisk WŁAŚNIE
// z ekranu ustawień — więc klik ustawiał flagę, a panel wyskakiwał dopiero
// po wyjściu z ustawień.
//
// Testu nie da się tu postawić na DOM (vitest chodzi w środowisku node, repo
// nie ma jsdom i nie dokładamy zależności), więc pilnujemy samego miejsca
// renderowania — bo to ono było błędem.
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

/** Wnętrze rozgałęzienia `state.appSettingsOpen ? … : <> … </>`. */
function settingsBranch(): string {
  const from = app.indexOf("state.appSettingsOpen ?");
  const to = app.indexOf("{state.pluginsOpen && <PluginsPanel />}", from);
  expect(from, "brak rozgałęzienia appSettingsOpen").toBeGreaterThan(-1);
  expect(to, "brak kotwicy PluginsPanel w tym rozgałęzieniu").toBeGreaterThan(from);
  return app.slice(from, to);
}

describe("miejsce renderowania paneli w powłoce", () => {
  it("panel Serwer i urządzenia stoi poza rozgałęzieniem ustawień", () => {
    expect(app).toContain("<ServerAccessPanel />");
    expect(settingsBranch()).not.toContain("<ServerAccessPanel");
  });

  it("renderuje się przed wierszem paneli, więc widać go także przy otwartych ustawieniach", () => {
    const panel = app.indexOf("{state.serverAccessOpen && <ServerAccessPanel />}");
    const row = app.indexOf('className="relative flex min-h-0 flex-1"');
    expect(panel).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(-1);
    expect(panel).toBeLessThan(row);
  });
});
