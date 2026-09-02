# Własność obszarów

Macierz przeniesiona z `docs/TEAM-WORKFLOW.md` i doprowadzona do stanu
faktycznego repo.

Własność nie oznacza wyłączności — oznacza, że w razie kolizji ta osoba
rozstrzyga kolejność i że jej zdanie waży najwięcej w przeglądzie.

## Obszary

| Obszar | Główne ścieżki | Bezpieczny obszar równoległy |
|---|---|---|
| Interfejs | `src/`, `public/`, `index.html` | `server/`, `engine/` |
| Harness (serwer Node) | `server/` | `src/`, `engine/` |
| Silnik (Python) | `engine/` | `src/`, większość `server/` |
| Powłoka desktopowa | `electron/`, `electron-builder.yml` | `engine/`, większość `server/` |
| Instalatory i dokumentacja | `scripts/`, `docs/`, Markdown w katalogu głównym | dowolny obszar kodu |
| Zarządzanie repo | `.github/`, `docs/engineering/`, `AGENTS.md` | dowolny obszar kodu |

`clients/mobile/` z poprzedniej wersji macierzy **nie istnieje w tym repo** —
aplikacja mobilna ma osobne repo `E4B-labs/multibot-mobile`. Wpis został
usunięty, żeby nikt go nie szukał.

Gdy dwie gałęzie muszą ruszyć ten sam plik: ustalcie kolejność przed
implementacją, druga gałąź robi rebase na pierwszej po jej merge'u i uruchamia
bramki od nowa.

## Pliki wymagające decyzji właściciela

| Plik / obszar | Dlaczego |
|---|---|
| `server/contracts.ts` | kanoniczne kształty danych i SPI driverów; zgadzają się z nim wszystkie drivery, interfejs i dane zapisane u użytkowników |
| kształt danych zapisywanych na dysku | brak bazy i migracji — zmiana kształtu psuje istniejące instalacje |
| `.github/workflows/` | zmiana bramek zmienia to, co blokuje merge dla wszystkich |
| `package.json` (zależności) | nowa zależność npm wymaga uzasadnienia; domyślnie jej nie dokładamy |
| `electron-builder.yml`, procedura wydania | psuje kanał auto-update, a objaw jest cichy |

## CODEOWNERS

Plik `.github/CODEOWNERS` przypisuje automatyczne żądania przeglądu.
Dziś zawiera **wyłącznie potwierdzoną tożsamość właściciela repo** —
konto GitHub `@E4B-labs`.

Konta Bartka i Mieszka nie są potwierdzone: w API repo widnieje jeden
kolaborator (`E4B-labs`, admin), organizacja `E4B-labs` nie istnieje (repo
należy do konta użytkownika), a loginy `SlafyGH` i `xNeQiu` istnieją na GitHubie,
ale nic w repo nie wiąże ich z konkretną osobą w sposób pewny.

Nieistniejący albo niebędący kolaboratorem login w `CODEOWNERS` jest **cicho
ignorowany** przez GitHub — reguła wygląda na działającą i nie robi nic. Dlatego
wpisy dla Bartka i Mieszka czekają w pliku jako zakomentowane miejsca, do
uzupełnienia przez właściciela po potwierdzeniu loginów i dodaniu obu osób jako
kolaboratorów repo.
