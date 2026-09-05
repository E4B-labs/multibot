<!--
Zasady: docs/engineering/PR_POLICY.md
Jeden PR = jedno zadanie. Nie doklejaj niepowiązanych porządków.
-->

## Co się zmieniło

<!-- Konkretnie, nie „poprawki". -->

## Dlaczego

<!-- Problem albo prośba, którą to zamyka. -->

## Dotknięte moduły

<!-- src/ · server/ · electron/ · scripts/ · docs/ · .github/ -->

## Poziom ryzyka

<!-- niski / średni / wysoki + jedno zdanie uzasadnienia -->

## Uruchomione testy — z wyjściem

<!-- Wklej liczby, nie deklarację. -->

```
pnpm lint            →
pnpm typecheck       →
pnpm test            →
pnpm exec vite build →
```

## Skutki migracyjne i dla danych

<!-- Czy zmienia się kształt zapisanych danych? Repo nie ma bazy ani migracji —
     dane to pliki JSON, więc zmiana kształtu psuje istniejące instalacje.
     Napisz, co się stanie ze starymi danymi. „Bez zmian" też jest odpowiedzią. -->

## Skutki dla API

<!-- Nowe, zmienione albo usunięte endpointy i pola server/contracts.ts.
     Zmiana contracts.ts wymaga decyzji właściciela — zaznacz ją wyraźnie. -->

## Znane ograniczenia

<!-- Czego ta zmiana świadomie nie robi. -->

## Zrzuty ekranu

<!-- Obowiązkowe, gdy zmienia się interfejs. -->

## Powiązane zadanie

<!-- Link do zadania albo issue, jeśli istnieje. -->

---

- [ ] Gałąź nazwana `<developer>/<type>/<task>`, założona z aktualnego `origin/main`
- [ ] Nie akceptowałem własnego PR-a
- [ ] Bramki uruchomione lokalnie, wyjście wklejone wyżej
- [ ] Brak sekretów, tokenów, adresów hostów i ścieżek zależnych od maszyny
- [ ] Nietrywialna logika zostawia uruchamialny test
