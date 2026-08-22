# CLAUDE.md

Reguły pracy nad tym repo leżą w **`AGENTS.md`** — przeczytaj go w całości,
zanim cokolwiek zrobisz. Najważniejsza jest sekcja 2: baza to najwyższe
wydanie, numer wersji zawsze rośnie, a cofnięcie wyglądu też jest zmianą
w przód, wydawaną pod nowym numerem.

Szczegóły infrastruktury (adres telefonu, procedura wdrożenia, plany, spec)
nie mogą leżeć na publicznym remote i żyją na lokalnej gałęzi
`historia-prywatna`:

```
git show historia-prywatna:CLAUDE.md
```

Aplikacja mobilna to osobne repo `E4B-labs/multibot2` z własnym `CLAUDE.md`.
Praca nad interfejsem zwykle dotyczy obu naraz — ale wydajesz wyłącznie ten
kanał, o który poprosił właściciel.
