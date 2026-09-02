# Gałęzie

## Nazewnictwo

```
<developer>/<type>/<task>
```

- `developer` — `kacper`, `bartek`, `mieszko`. Agent AI używa nazwiska osoby,
  w imieniu której działa; nie ma osobnych nazw dla narzędzi.
- `type` — `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`.
- `task` — krótki opis w myślnikach; jeśli zadanie ma identyfikator, wchodzi na
  początek: `kacper/feat/MB-184-billing-dashboard`.

Przykłady: `kacper/feat/billing-dashboard`, `bartek/fix/refresh-token`,
`mieszko/refactor/database-client`.

**Nie zakładamy stałych gałęzi osobowych** (`kacper`, `bartek`, `mieszko`).
Gałąź jest jednorazowa i żyje tyle, co zadanie. Nazwa niesie właściciela i
zadanie, więc dwie osoby (albo dwa agenty) nie trafią przypadkiem w tę samą.

## Baza

Zawsze aktualny `origin/main`:

```sh
git fetch origin
git worktree add <lokalna-ścieżka> -b kacper/feat/moja-zmiana origin/main
```

Nigdy nie odgałęziasz się od cudzej gałęzi zadaniowej ani od lokalnego,
nieodświeżonego `main`. Wyjątek: świadoma współpraca dwóch osób nad jednym
zadaniem, ustalona wprost — i wtedy nadal jest jeden właściciel zapisu.

Tej samej gałęzi zadaniowej nie prowadzi się jednocześnie z dwóch komputerów.

## Aktualizacja gałęzi

Gałąź zadaniowa jest twoja, więc porządkujesz ją przez `rebase`:

```sh
git fetch origin && git rebase origin/main
git push --force-with-lease
```

`--force-with-lease`, nigdy `--force`. `main` nie jest nigdy nadpisywany
(`non_fast_forward` blokowane po stronie GitHuba — zob.
[`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md)). Po rebase bramki lecą jeszcze raz;
zielone sprzed rebase'u niczego nie dowodzi.

Gałąź, w którą ktoś inny już patrzy albo z której odgałęził swoją, aktualizujesz
`merge`, nie `rebase` — przepisanie historii pod cudzymi nogami tworzy konflikty
z niczego.

## Kasowanie po merge'u

Gałąź kasujemy zaraz po merge'u — lokalnie, zdalnie i razem z worktree:

```sh
git worktree remove <lokalna-ścieżka>
git branch -d <developer>/<type>/<task>
git push origin --delete <developer>/<type>/<task>
```

Zalecenie do włączenia po stronie repo: **`delete_branch_on_merge: true`**
(dziś wyłączone). Wtedy GitHub kasuje gałąź zdalną sam, a zostaje tylko
sprzątnięcie lokalnego worktree.

## Zaległość do sprzątnięcia (stan 02.09.2026)

Lista z audytu. **Niczego tu nie kasujemy w ramach tej zmiany** — to backlog do
przejrzenia przez właściciela, nie zadanie dla agenta. Gałąź kasuje się dopiero,
gdy wiadomo, co w niej było.

Zdalne, zmergowane, bezpieczne do skasowania (8):

```
fix/private-full-autonomy      fix/team-full-access
mieszko/feat/avatar-and-updater-pc   release/0.2.3
ui/layout-0828                 ui/remove-groups-0828
ui/sections-room-0828          ui/session-time-0828
```

Zdalna, niezmergowana — wymaga decyzji, nie kasowania w ciemno:

```
origin/preserve/colleague-wip-20260828
```

Lokalne, zmergowane, bez własnych commitów (11): `feature/multiuser-v2`,
`fix/message-order-20260830`, `fix/team-full-access`, `release/0.2.3`,
`ui/remove-groups-0828`, `ui/sections-room-0828`, `ui/session-time-0828`,
`ui/settings-screen-0.1.82`, `hide-memory`, `release-0.1.37`, `release-0.1.38`.

Lokalne z niezmergowanymi commitami — najpierw sprawdź, co w nich siedzi:
`fix/private-full-autonomy` (3), `ui/layout-0828` (1),
`preserve/colleague-wip-20260828` (1), `lokalne-przed-pull-2026-09-02` (1, kopia
zapasowa).

Do tego 12 worktree na maszynie właściciela, w tym trzy w stanie `detached
HEAD`. Worktree bez aktywnego zadania jest śmieciem: `git worktree list`, potem
`git worktree remove` albo `git worktree prune`.

Nazwy typu `feature/…`, `ui/…`, `release/…`, `hide-memory` pochodzą sprzed tej
konwencji. Nowe gałęzie trzymają się wzoru `<developer>/<type>/<task>`; starych
nie przemianowujemy — wygasną razem z zaległością.
