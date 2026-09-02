# Wydania

Reguły przeniesione z `AGENTS.md` (sekcje 1, 2 i 4 sprzed przebudowy protokołu).
Zostają w całości: dwa razy kosztowały właściciela zepsute wydanie.

> **Desktop release:** tagi i assety wydań desktopowych publikujemy w repo
> [`E4B-labs/multibot-desktop-releases`](https://github.com/E4B-labs/multibot-desktop-releases/tags).
> Następny numer wersji sprawdzaj właśnie tam; **nie publikuj release'ów
> desktopa w repo źródłowym.**

---

## 1. Trzy kanały. Mogą się różnić. Sprawdź każdy.

| Kanał | Co to | Skąd użytkownik to bierze |
|---|---|---|
| **serwer na telefonie** | `dist` + `dist-server` wgrane tarem, restart usługi | przeglądarka pod adresem hosta |
| **desktop** | paczka Electrona, GitHub Releases `E4B-labs/multibot-desktop-releases` | auto-update w aplikacji |
| **aplikacja mobilna** | bundle z repo `multibot-mobile`, `eas update --branch production` | aktualizacja w aplikacji |

**Te trzy kanały nie muszą stać na tym samym kodzie i często nie stoją.**
22.08.2026 desktop świadomie wyprzedzał telefon o cały zestaw zmian
interfejsu — użytkownik tak poprosił. „U mnie wygląda inaczej niż na
telefonie" bywa więc stanem zamierzonym, nie awarią.

**Nigdy nie zakładaj, co jest wydane. Zmierz to:**

```sh
git log --oneline -5                                                # co jest w repo
gh release list --repo E4B-labs/multibot-desktop-releases --limit 5 # co ma desktop
git show <tag>:package.json | grep version                          # co siedzi w tym wydaniu
```

Procedury dla telefonu i aplikacji mobilnej to prywatne notatki wdrożeniowe
właściciela; żyją poza remote i podstawowy przepływ pracy ich nie wymaga.

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
   ```sh
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

## 3. Wydanie

Push na GitHub to **nie** jest wydanie. Dopóki zmiana nie pójdzie kanałem,
u użytkownika nic się nie zmienia. **Wydania robi się z `main` po merge'u PR,
nigdy z gałęzi zadaniowej.**

- **desktop**: bump `version` w `package.json`, `pnpm package:win`,
  `gh release create vX.Y.Z <exe> latest.yml <blockmap> --repo E4B-labs/multibot-desktop-releases`.
  Bez `latest.yml` auto-update nie widzi wydania. Po budowaniu przywróć
  `electron/vendor/electron-updater.cjs` (`git checkout --`).
  Paczkowanie przechodzi jeszcze przez `pnpm build:server`
  (`tsc -p tsconfig.server.build.json`) — to krok paczkujący, nie bramka CI.
- **telefon** i **aplikacja mobilna**: prywatne notatki wdrożeniowe właściciela.
- Wydajesz **tylko ten kanał, którego zmiana dotyczy**. Zmiana w `electron/`
  nie jedzie na telefon; zmiana w `src/` jedzie tam, gdzie użytkownik poprosił,
  i tylko tam.

Pliki tymczasowe paczkowania kierujesz przez `TEMP`/`TMP` i
`ELECTRON_BUILDER_CACHE` na dysk wskazany przez właściciela maszyny — nigdy na
sztywno w skrypcie repo.
