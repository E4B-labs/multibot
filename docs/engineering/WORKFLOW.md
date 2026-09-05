# Cykl pracy nad zadaniem

Od pobrania stanu do merge'a. Obowiązuje tak samo człowieka i agenta AI.
Reguły skrócone są w [`../../AGENTS.md`](../../AGENTS.md); tu jest pełna procedura.

GitHub jest warstwą synchronizacji i jedynym źródłem prawdy. Lokalny stan
komputera jest jednorazowy — Kacper, Bartek i Mieszko trzymają repo na innych
dyskach, w innych katalogach, pod innymi systemami. Żadna reguła nie może
zależeć od zgodności ścieżek lokalnych.

## 1. Zadanie

Zadanie ma jednego właściciela zapisu — człowieka albo wskazanego agenta
działającego w jego imieniu. Zanim cokolwiek napiszesz, sprawdź, czy ktoś już
tego nie robi:

```sh
gh pr list --repo E4B-labs/multibot-desktop
git fetch origin && git branch -r
```

Nakładające się pliki, ten sam moduł, ten sam kształt danych — dogadaj kolejność
przed implementacją, nie po. Duplikowanie pracy w ciszy jest gorsze niż jedno
pytanie.

## 2. Gałąź i worktree

```sh
git fetch origin
git worktree add <lokalna-ścieżka> -b <developer>/<type>/<task> origin/main
cd <lokalna-ścieżka>
corepack enable
pnpm install --frozen-lockfile
```

`<lokalna-ścieżka>` wybierasz sam — to twoja maszyna. Przykłady (nie kanon):
`~/worktrees/multibot-billing`, `D:\worktrees\mb-auth`, `/Users/x/wt/mb-fix`.
Ścieżka nigdy nie trafia do plików repo.

Jedno zadanie = jedna gałąź = jeden worktree = jeden PR. Kilku agentów na
jednej maszynie pracuje w osobnych worktree; równoległe pisanie w jednym
katalogu kończy się nadpisanymi plikami, których git nawet nie zauważy.

## 3. Praca

Najpierw przeczytaj kod, który zmieniasz. Potem zmieniaj. Pliki dodajesz do
commitu po nazwie (`git add <plik>`), nigdy `git add -A` — w drzewie bywają
cudze niezacommitowane zmiany.

Commity małe i konwencjonalne (`feat(auth): …`, `fix(payments): …`). Nie łącz
niepowiązanych zmian. Nie commituj świadomie zepsutego kodu.

## 4. Bramki lokalnie — przed pushem

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm exec vite build
```

Te cztery komendy to dokładnie to, co
uruchamia CI (`.github/workflows/ci.yml`) na macOS, Ubuntu i Windows. Odpalenie
ich lokalnie zanim wypchniesz gałąź jest jedyną rzeczą, która oddziela zielone
CI od czerwonego — historia tego repo pokazuje, co się dzieje bez tego
(zob. [`REPO_STATE.md`](REPO_STATE.md)).

Lokalnie odpalasz jeden system operacyjny. Testy zależne od POSIX-a same się
pomijają na Windowsie, a część zachowań macOS-a i Linuksa udowodni dopiero CI.
Lokalne zielone to warunek konieczny, nie wystarczający.

## 5. Push i PR

```sh
git push -u origin <developer>/<type>/<task>
gh pr create --base main --repo E4B-labs/multibot-desktop
```

Treść PR wypełniasz według szablonu (`.github/PULL_REQUEST_TEMPLATE.md`);
wymagania opisuje [`PR_POLICY.md`](PR_POLICY.md).

## 6. Gdy `main` ruszy pod tobą

```sh
git fetch origin
git rebase origin/main     # gałąź zadaniowa, tylko twoja
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
git push --force-with-lease
```

`--force-with-lease`, nigdy `--force`, i wyłącznie na własnej gałęzi
zadaniowej — nigdy na `main` i nigdy na gałęzi, na której pracuje ktoś inny.
Konfliktów nie rozwiązujesz na oko: zrozum obie strony i zachowaj zamierzone
zachowanie obu. Po rozwiązaniu konfliktu bramki lecą jeszcze raz.

## 7. Przegląd i merge

CI musi być zielone na dokładnie tym HEAD-zie, który idzie do merge'a — nie na
tym, który był zielony trzy godziny temu. Dalej: przegląd, poprawki, bramka
merge'a, merge. Autor nie akceptuje własnej pracy i nie mergeuje sam.

## 8. Po merge'u

```sh
git switch main && git pull --ff-only origin main
git worktree remove <lokalna-ścieżka>
git branch -d <developer>/<type>/<task>
git push origin --delete <developer>/<type>/<task>   # jeśli GitHub nie skasował sam
```

Docelowo `delete_branch_on_merge` robi ostatni krok automatycznie
(zob. [`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md)). Porzucone worktree i gałęzie
sprzątasz od razu — po tygodniu nikt już nie pamięta, czy coś w nich było.

## 9. Wydanie

Merge do `main` to nie wydanie. Kanały, numeracja i procedura paczkowania:
[`RELEASE.md`](RELEASE.md).
