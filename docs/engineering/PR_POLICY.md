# Zasady pull requestów

Każde ukończone zadanie idzie przez PR. Bezpośredni push na `main` nie jest
skrótem — jest awarią procesu.

Szablon opisu: [`../../.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md).

## Co musi być w PR

1. **Co się zmieniło** — konkretnie, nie „poprawki".
2. **Dlaczego** — problem albo prośba, którą to zamyka.
3. **Dotknięte moduły** — `src/`, `server/`, `engine/`, `electron/`, `scripts/`, `docs/`.
4. **Poziom ryzyka** — niski / średni / wysoki, z jednym zdaniem uzasadnienia.
5. **Uruchomione testy wraz z wyjściem** — wklejone liczby, nie deklaracja.
6. **Skutki migracyjne** — czy zmienia się kształt zapisanych danych.
7. **Skutki dla warstwy danych** — repo nie ma bazy ani migracji; dane to pliki
   JSON, więc zmiana kształtu psuje instalacje, które już istnieją. Napisz, co
   się stanie ze starymi danymi.
8. **Skutki dla API** — nowe, zmienione albo usunięte endpointy i pola
   `server/contracts.ts`.
9. **Znane ograniczenia** — czego ta zmiana świadomie nie robi.
10. **Zrzuty ekranu**, gdy zmienia się interfejs.
11. **Powiązane zadanie / issue**, jeśli istnieje.

## PR ma być skupiony

Jeden PR realizuje jedno zadanie. Nie doklejasz niepowiązanych porządków ani
refaktorów do PR-a z funkcją — chyba że zmiana bez nich nie działa, a wtedy
piszesz w opisie, dlaczego.

Duży PR, którego nie da się przejrzeć, jest w praktyce nieprzejrzany.

## Role

| Rola | Wolno | Nie wolno |
|---|---|---|
| autor (człowiek albo agent) | pisać kod, odpowiadać na uwagi, poprawiać | akceptować własnego PR-a, mergeować własnej pracy |
| recenzent (`multibot/review`) | wskazywać błędy, żądać poprawek, akceptować | mergeować |
| strażnik bramki (`multibot/merge-gate`) | sprawdzić, że bramki i przegląd są zamknięte, i zmergować | przepisywać kod funkcji |

Rozdział ról jest celowy: kto pisze, ten nie ocenia; kto ocenia, ten nie
mergeuje; kto mergeuje, ten nie poprawia kodu po drodze. Ktokolwiek zaczyna
łączyć te role, obchodzi cały mechanizm.

## Bramki

CI musi być zielone na **dokładnie tym HEAD-zie, który idzie do merge'a**.
Gałąź musi być zaktualizowana względem `main`. To, że testy przeszły trzy
godziny temu, nie mówi nic o zgodności z dzisiejszym `main`.

Docelowe wymagane checki i sposób ich włączenia:
[`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md).

## Przegląd

Recenzent sprawdza co najmniej:

- poprawność i przypadki brzegowe,
- wpływ na bezpieczeństwo (repo jest publiczne — żadnych sekretów, adresów ani
  tokenów w kodzie, logach i opisie PR),
- zachowanie na trzech systemach (macOS, Linux, Windows),
- zgodność wstecz zapisanych danych,
- stabilność `server/contracts.ts` — zmiana tego pliku wymaga decyzji
  właściciela i musi być w PR wyraźnie zaznaczona,
- brak nowych zależności npm dla czegoś, co robi kilka linii,
- brak ścieżek zależnych od maszyny (litera dysku, katalog domowy, lokalny adres IP).

Wątki komentarzy zamyka się przed merge'em. Nierozwiązany wątek to brak zgody,
a nie drobiazg.

## Konflikty

Konfliktów nie rozwiązuje się na oko. Zrozum obie strony i zachowaj zamierzone
zachowanie obu, potem uruchom bramki od nowa. Jeśli nie wiesz, co druga strona
miała robić — zapytaj jej autora, nie zgaduj.
