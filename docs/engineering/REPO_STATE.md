# Stan repozytorium — migawka 02.09.2026

Zdjęcie stanu w chwili wprowadzania protokołu inżynierskiego. Zastępuje dawny
`GATES.md`, który zatrzymał się na wersji 0.1.70, podczas gdy `package.json`
stoi na **0.3.16** — dwie prawdy naraz są gorsze niż jedna nieaktualna.

Ten plik nie jest żywym dashboardem. Jest punktem odniesienia: „tak było, gdy
zakładaliśmy proces". Aktualizuje się go świadomie, przy większych zmianach.

---

## 1. Podstawy

| | |
|---|---|
| Repo | `E4B-labs/multibot-desktop` (publiczne; przemianowane z `E4B-labs/multibot`, przekierowanie działa) |
| Gałąź domyślna | `main`, HEAD `82ee7062` |
| Wersja | `package.json` 0.3.16 |
| Runtime | Node >= 24, pnpm 10.33.0, Python 3.12 |
| Śledzonych plików | 459 |
| Testy | vitest: 104 pliki / 624 testy; pytest: 39 plików / 311 testów (obie liczby zmierzone, nie policzone z drzewa) |

Właściciel repo to **konto użytkownika** `E4B-labs`, nie organizacja
(`orgs/E4B-labs` zwraca 404). Jedyny kolaborator z uprawnieniami: `E4B-labs`
(admin).

> **Uwaga tożsamościowa.** `clewkord` **nie jest loginem GitHuba**
> (`GET /users/clewkord` → 404); to adres e-mail autora commitów i etykieta
> wpisu w lokalnym keyringu `gh`, pod którą siedzi token konta `E4B-labs`.
> Wpisanie `@clewkord` do `CODEOWNERS` byłoby regułą, którą GitHub **cicho
> zignoruje**. Dlatego `CODEOWNERS` wskazuje `@E4B-labs`.

## 2. Gałęzie i worktree

0 otwartych PR-ów. 10 PR-ów historycznie, wszystkie zmergowane, wszystkie z
konta `E4B-labs`. Nazwy gałęzi w tych PR-ach: `codex/<typ>/<opis>` (6),
`mieszko/<typ>/<opis>` (1), gołe `feature|fix|release/` (3).

Historia `first-parent` ostatnich 60 commitów: **5 merge'y, 55 bezpośrednich
pushy**. 02.09.2026 trzy commity poszły prosto na `main` (`a0f3d25a`,
`2a78835d`, `82ee7062`). To jest stan wyjściowy, który ten protokół zamyka.

Pełna lista gałęzi i worktree do sprzątnięcia: [`BRANCHING.md`](BRANCHING.md).
**Nic nie zostało skasowane** — to backlog dla właściciela.

## 3. CI — dlaczego było czerwone

Workflow `CI` (`.github/workflows/ci.yml`): **2 z 24 uruchomień zielone**.
Zbadano 10 uruchomień z 24; przyczyny nie są jedną awarią, tylko serią
niezależnych testów psutych i naprawianych po kolei:

| Test | Objaw | Status |
|---|---|---|
| `server/polish.test.ts` | `expected … to contain 'Napisz do pokoju'` na wszystkich trzech systemach | **naprawione w tym PR** |
| `server/group-store.test.ts` | `ENOENT: mkdtemp 'D:\tmp/multibot-group-XXXXXX'` — ścieżka jednej maszyny zaszyta w teście, pada na Linuksie i macOS | naprawione wcześniej |
| `server/permission-proxy.test.ts` | timeout 30 s na Linuksie i Windowsie, `EACCES` na gnieździe unixowym na macOS | naprawione wcześniej; w CI tego PR-a przechodzi na Ubuntu i macOS (2 testy), a na Windowsie jest świadomie pomijany |
| `server/drivers/claude.test.ts` | `spawn_error` nie pasuje do oczekiwanego kształtu | naprawione wcześniej |
| `server/turn-tools.test.ts` | listy narzędzi rozjechane (31 vs 33) | naprawione wcześniej |

**Przyczyna źródłowa nie jest techniczna.** Każdy z tych testów pada
deterministycznie i lokalnie, w kilkanaście sekund. Czerwone CI brało się z
tego, że zmiany trafiały prosto na `main` bez uruchomienia bramek — CI był
pierwszym miejscem, gdzie ktokolwiek uruchamiał testy. Wymagane checki na
gałęzi `main` bez tej zmiany blokowałyby **każdy** PR, łącznie z tym.

Naprawa w tym PR: `a0f3d25a` świadomie zamienił jedno pole „napisz do pokoju"
na osobne pola zadań per bot; strażnik etykiet polskich wymagał usuniętego
napisu. Guard pilnuje teraz etykiety, która istnieje (`Zadanie dla tego bota`).

## 4. Ochrona `main`

| | Obecnie | Docelowo |
|---|---|---|
| klasyczna ochrona `main` | jest: `enforce_admins`, blokada force-push i kasowania, wymagane rozwiązanie wątków | zastąpiona rulesetem |
| wymagana recenzja | zapisana (`required_approving_review_count: 1`), ale **nieegzekwowana** — zasób nadrzędny pokazuje `null`, a PR ma stan `UNSTABLE`, nie `BLOCKED` | realny wymóg w rulesecie, po rozstrzygnięciu kto recenzuje |
| wymagane checki | **brak** (endpoint 404) | 3 legi `lint + typecheck + test (…)`, potem `multibot/review` i `multibot/merge-gate` |
| rulesety | `[]` | ruleset dla `main` |
| `delete_branch_on_merge` | `false` | `true` |
| pinowanie SHA w Actions | `false` | do rozważenia |

Dokładne komendy i JSON: [`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md) —
**nie zastosowano**, wykonuje właściciel.

## 5. Decyzje podjęte w tej zmianie

**Nie dokładamy formatera (Prettier / ESLint / Biome).** Dziś repo nie ma
żadnego; `pnpm lint` to `git diff --check && tsc --noEmit`. Zakaz z `AGENTS.md`
mówi wprost: nie dokładamy zależności npm dla czegoś, co robi kilka linii.
Formater dołożony teraz przeformatowałby 459 plików i zamienił każdy przyszły
PR w nieczytelny diff. Jeśli właściciel zdecyduje inaczej, to jest osobne
zadanie z osobnym PR-em — nie doklejka do zmiany porządkującej. `.editorconfig`
dodany w tym PR ustala odstępy i końce linii bez żadnej zależności.

**`engine.yml` traci filtr `paths:`.** Filtr sprawiał, że przy PR-ze nietykającym
`engine/` checki `pytest (…)` w ogóle nie startowały — a wymagany check, który
nie startuje, zostaje na zawsze w stanie „Expected" i blokuje merge. Alternatywą
był bliźniaczy workflow-atrapa o tej samej nazwie joba, ale wtedy PR ruszający i
`engine/`, i resztę uruchamia dwa checki o identycznej nazwie i GitHub nie wie,
który liczyć. Repo jest publiczne, więc minuty Actions są darmowe — tańsze i
jednoznaczne jest uruchamianie pytestu zawsze.

**`GATES.md` skasowany.** Zawierał stan z wersji 0.1.70, adresował repo pod starą
nazwą i zapisywał wydania w repo źródłowym, czego `AGENTS.md` zabrania.
Nie odwoływał się do niego żaden inny plik. Rola „gdzie jest stan projektu"
przechodzi na ten plik.

**Prywatna gałąź `historia-prywatna` znika z dokumentacji.** `AGENTS.md` i
`CLAUDE.md` kazały czytać `git show historia-prywatna:CLAUDE.md`. Ta gałąź jest
wyłącznie lokalna, nigdy nie była wypchnięta i jest niewykonalna dla kogokolwiek
poza jedną maszyną. Prywatne notatki wdrożeniowe właściciela żyją poza remote;
podstawowy przepływ pracy ich nie wymaga.

## 6. Dług techniczny

- **Wielkie pliki jako punkty kolizji**: `server/index.ts` 4735 linii,
  `src/components/CursorAvatar.tsx` 1814, `src/components/Sidebar.tsx` 1354,
  `engine/server/app.py` 1280, `src/state/store.tsx` 1119. Dwie gałęzie w
  `server/index.ts` naraz to najbardziej prawdopodobny konflikt w tym repo.
- **Pięć testów, których nikt nie uruchamia**: `vite.config.ts` włącza tylko
  trzy pliki z `electron/`, więc testy `gpu`, `hardware-acceleration`,
  `host-resolve`, `remote-ui`, `updater` napisane pod `node:test` są martwe.
- **`hermes-agent` nie jest przypięty lockfile'em.** CI robi `git clone` +
  `checkout 17688f9`. SHA leży w trzech miejscach (`engine/requirements.txt` w
  komentarzu, `.github/workflows/engine.yml`, `engine/SLAFY-BOT-SHA.txt`) i nic
  nie pilnuje, żeby były zgodne. Zniknięcie albo przepisanie gałęzi upstreamu
  wywraca CI silnika. Do rozważenia: jedno miejsce z SHA plus krok CI
  sprawdzający zgodność.
- **Ścieżki jednej maszyny w kodzie silnika**: `engine/server/bots.py`,
  `engine/server/providers.py` (domyślny katalog danych),
  `engine/server/gateway.py` (katalog przeglądarek Playwright) mają zaszyte
  ścieżki windowsowe z dysku właściciela. Działają dzięki zmiennym
  środowiskowym, ale domyślne wartości są nieprzenośne. Do naprawy osobnym PR-em
  — poza zakresem zmiany porządkowej.
- **Zmienne środowiskowe bez dokumentacji**: około 20 nazw czytanych przez kod
  nie miało żadnego przykładu. Najważniejsze zostały dopisane jako komentarze do
  `.env.example` (same nazwy, bez wartości). Pełna lista
  pozostałych — w kodzie; docelowo warto dokończyć.
- **Brak bazy i migracji.** Dane to pliki JSON. Nie ma bramki migracyjnej do
  uruchomienia, ale zmiana kształtu danych psuje istniejące instalacje bez
  ostrzeżenia.

## 7. Ryzyka kolizji

| Ryzyko | Skąd |
|---|---|
| dwie gałęzie w `server/index.ts` | 4735 linii, cała obsługa HTTP w jednym pliku |
| zmiana `server/contracts.ts` | wszystkie drivery i interfejs zgadzają się z tym plikiem naraz |
| zmiana promptu systemowego w jednej ścieżce | prompt ma dwie drogi: drivery CLI i `engine/server/bots.py` |
| zmiana kształtu zapisanych danych | brak migracji, brak wersjonowania plików |
| dwa agenty w jednym worktree | git tego nie zgłosi; kod znika po cichu |

## 8. Plan migracji: stan obecny → docelowy

1. **Zrobione w tym PR**: `AGENTS.md` jako kanon, `docs/engineering/`, szablon
   PR-a, `CODEOWNERS`, `.editorconfig`, `.gitattributes` z `* text=auto`,
   `.dockerignore` z `.env*`, `engine.yml` bez filtru `paths`, naprawa
   czerwonego CI, likwidacja sprzecznych list bramek.
2. **Właściciel — po zmergowaniu tego PR**: włączyć ruleset dla `main` z fazy 1
   i `delete_branch_on_merge: true` ([`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md)).
   Sprawdzić na testowym PR-ze, potem usunąć klasyczną ochronę, żeby została
   jedna prawda.
3. **Właściciel**: potwierdzić loginy GitHub Bartka i Mieszka, dodać ich jako
   kolaboratorów, uzupełnić `CODEOWNERS`.
4. **Zespół**: przejść na gałęzie `<developer>/<type>/<task>` i worktree; koniec
   bezpośrednich pushy na `main`.
5. **Później**: sprzątnięcie zaległych gałęzi i worktree, decyzja o pięciu
   martwych testach Electrona, jedno miejsce na SHA `hermes-agent`, wyczyszczenie
   ścieżek maszynowych w `engine/`.
6. **Faza 2**, gdy recenzent i bramka MultiBota faktycznie wystawiają statusy:
   dopisać `multibot/review` i `multibot/merge-gate` do wymaganych checków.
