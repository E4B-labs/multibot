# MultiBot — instrukcja dla agentów AI

> Czytane automatycznie przez agenty (Claude Code, OpenCode i inne).
> Przeczytaj CAŁOŚĆ, zanim dotkniesz kodu, gita albo czegokolwiek, co wydaje.

To repo (`E4B-labs/multibot`, gałąź `main`, **publiczne**) trzyma serwer,
interfejs webowy i aplikację desktopową (Electron). Aplikacja mobilna mieszka
w osobnym, prywatnym repo `E4B-labs/multibot2` i ma własny `AGENTS.md`.

**Zanim zaczniesz — przeczytaj też prywatną instrukcję**, która nie może leżeć
na publicznym remote (adresy, telefon, infrastruktura):

```
git show historia-prywatna:CLAUDE.md
```

Tam są: sposób pracy z subagentami, adres i procedura wdrożenia na telefon,
macierz kanałów, pułapki infrastruktury. Ten plik jest nadrzędny tylko w
sekcji 2 (baza i numeracja) — reszta uzupełnia się wzajemnie.

---

## 1. Trzy kanały. Mogą się różnić. Sprawdź każdy.

| Kanał | Co to | Skąd użytkownik to bierze |
|---|---|---|
| **serwer na telefonie** | `dist` + `dist-server` wgrane tarem, restart usługi | przeglądarka pod adresem hosta |
| **desktop** | paczka Electrona, GitHub Releases `E4B-labs/multibot` | auto-update w aplikacji |
| **aplikacja mobilna** | bundle z repo `multibot2`, `eas update --branch production` | aktualizacja w aplikacji |

**Te trzy kanały nie muszą stać na tym samym kodzie i często nie stoją.**
22.08.2026 desktop świadomie wyprzedza telefon o cały zestaw zmian
interfejsu — użytkownik tak poprosił. „U mnie wygląda inaczej niż na
telefonie" bywa więc stanem zamierzonym, nie awarią.

**Nigdy nie zakładaj, co jest wydane. Zmierz to:**

```
git log --oneline -5                                   # co jest w repo
gh release list --repo E4B-labs/multibot --limit 5     # co ma desktop
git show <tag>:package.json | grep version             # co siedzi w tym wydaniu
```
Telefon i aplikacja mobilna: komendy w prywatnym `CLAUDE.md` (adres hosta
i `eas update:list`).

---

## 2. Baza i numeracja — reguła, przez którą to się psuło dwa razy

**Twoja zmiana idzie NA WIERZCH stanu wydanego, nigdy obok niego.**

1. **Baza to najwyższe wydanie, nie ostatni commit, który widzisz.** Zanim
   zaczniesz, sprawdź `gh release list`. Jeśli `main` jest niżej niż ostatnie
   wydanie, zatrzymaj się i zapytaj — ktoś wydawał z gałęzi bocznej.
2. **Numer wersji rośnie. Zawsze.** Jest 0.1.40, robisz zmianę — jest 0.1.41.
   Nigdy nie wydajesz ponownie numeru, który już istnieje, i nigdy nie
   zjeżdżasz w dół: aktualizator desktopu schodzi wyłącznie w górę, więc
   wydanie ze starszym numerem po prostu nie dojdzie do nikogo i nikt tego
   nie zgłosi.
3. **Cofnięcie wyglądu to też zmiana w przód.** Chcesz wrócić do stanu
   sprzed trzech wydań: przywracasz drzewo z tamtego commitu, ale wydajesz
   je pod NOWYM, wyższym numerem, z commitem `revert:` opisującym, co i
   dlaczego wyleciało. Nie „nadpisujesz wersji" i nie ruszasz starych tagów.
   Procedura:
   ```
   git checkout <dobry-commit> -- .
   git diff --name-only --diff-filter=A <dobry-commit> HEAD | xargs git rm -f
   git diff --quiet <dobry-commit> -- . && echo "drzewo identyczne"
   ```
   Ostatnia linia to dowód, że przywróciłeś dokładnie tamten stan, a nie
   „mniej więcej".
4. **Nie kasujesz cudzej pracy przy okazji.** Zanim wycofasz cokolwiek,
   `git log --oneline <baza>..HEAD` i wypisz w raporcie, co dokładnie
   wypada. Jeśli w wycofywanym zakresie są rzeczy niezwiązane z prośbą —
   zapytaj, zamiast wycinać wszystko hurtem.
5. **Wydania i grupy zostają.** Stare wydania GitHuba i grupy EAS to jedyna
   droga powrotu (`eas update:republish --group <id>` cofa aplikację mobilną
   w kilkanaście sekund, bez budowania). Nie kasujesz ich.

### Co poszło źle dwa razy — żeby nie było trzeciego

- Agent „naprawił" objaw bez dowodu z konsoli, a jego „diagnostyczne
  wycofanie" przywróciło plik z commitu, który sporną zmianę zawierał. Objaw
  nie zniknął, poszły trzy niepotrzebne wydania.
- Agent wydał zmiany interfejsu, użytkownik poprosił o powrót, kolejny agent
  cofnął je „na oko" i przy okazji zabrał funkcje, o które nikt nie prosił.
  Stąd punkt 3 z dowodem `git diff --quiet` i punkt 4 z wypisaniem zakresu.

**Reguła nadrzędna: dowód, nie przekonanie.** Zadanie jest zrobione, gdy
wkleisz wyjście bramki i identyfikator wydania. „Powinno działać" się nie
liczy. Przy diagnozie: najpierw złap błąd z konsoli albo z logu, dopiero
potem edytuj kod.

---

## 3. Bramki przed commitem

```
npx tsc -b                     # musi być czysto
npx vitest run                 # cała suita
npx vite build                 # interfejs
npx tsc -p tsconfig.server.build.json   # serwer
```
Nietrywialna logika zostawia jeden uruchamialny test obok istniejących —
bez nowych frameworków i bez nowych zależności. Test, który nie pada na
starym kodzie, niczego nie pilnuje: sprawdź, że pada, zanim uznasz go za
dowód.

---

## 4. Wydanie

Push na GitHub to **nie** jest wydanie. Dopóki zmiana nie pójdzie kanałem,
u użytkownika nic się nie zmienia.

- **desktop**: bump `version` w `package.json`, `pnpm package:win`,
  `gh release create vX.Y.Z <exe> latest.yml <blockmap> --repo E4B-labs/multibot`.
  Bez `latest.yml` auto-update nie widzi wydania. Po budowaniu przywróć
  `electron/vendor/electron-updater.cjs` (`git checkout --`).
- **telefon** i **aplikacja mobilna**: procedura w prywatnym `CLAUDE.md`.
- Wydajesz **tylko ten kanał, którego zmiana dotyczy**. Zmiana w
  `electron/` nie jedzie na telefon; zmiana w `src/` jedzie tam, gdzie
  użytkownik poprosił, i tylko tam.

---

## 5. Zakazy

1. **Nie piszesz na dysk C:** — jest chronicznie pełny i psuje instalacje
   ciszej niż jakikolwiek błąd. `$env:TEMP='D:\tmp'`,
   `ELECTRON_BUILDER_CACHE` na `D:`.
2. **Nie `git add -A`.** W drzewie bywają cudze niezacommitowane zmiany.
   Pliki dodajesz po nazwie. Nigdy `--force`.
3. **Sekrety nigdzie**: ani w repo, ani w logu, ani w raporcie, ani w
   pamięci Brain (tam idą tylko nazwy sekretów). To repo jest publiczne —
   adresy hostów i tokeny zostają w prywatnej gałęzi i w środowisku.
4. **Nie zmieniasz `server/contracts.ts`** ani kształtu zapisanych danych
   bez decyzji właściciela.
5. **Nie dokładasz zależności npm** dla czegoś, co robi kilka linii.

---

## 6. Pamięć zespołu

Wszystko, co warto pamiętać jutro — decyzja z powodem, pułapka, przepis na
wydanie, aktualny stan kanałów — idzie do **TaskTree Brain** przez serwer MCP
TaskTree (`brain_add`), w tej samej turze, w której to ustalisz. Przed pracą
nad znanym tematem: `brain_entity("MultiBot")`. Pliki lokalne to tylko
podręczny cache.

---

## 7. Raport po zadaniu

1. co zmienione — pliki i po co,
2. dowód bramek — wklejone wyjście z liczbami,
3. co wydane i gdzie — kanał plus identyfikator (hash, wersja, grupa EAS),
4. czego **nie** zrobiłeś i dlaczego,
5. co wymaga właściciela (decyzja, token, klik).
