# Ustawienia GitHuba dla `E4B-labs/multibot-desktop`

## NIE ZASTOSOWANO - do wykonania przez właściciela

Ten dokument opisuje **stan docelowy**, a nie stan faktyczny. Żadne ustawienie
opisane niżej nie zostało włączone. Wszystkie polecenia poniżej są do
świadomego uruchomienia przez właściciela repozytorium (`E4B-labs`). Agent,
który pisał ten plik, wykonywał wyłącznie odczyty (`GET`).

Stan zweryfikowany odczytem 2026-09-02:
`GET /repos/E4B-labs/multibot-desktop/rulesets` zwraca `[]`, czyli nie ma
żadnego zestawu reguł. Klasyczna ochrona gałęzi `main` istnieje.

Repozytorium należy do konta **użytkownika**, nie organizacji
(`owner.type = User`, `orgs/E4B-labs` zwraca 404), więc zestawy reguł na
poziomie organizacji są niedostępne. Jedyna droga to zestaw reguł na poziomie
repozytorium.

---

## 1. Obecny stan a stan docelowy

| Ustawienie | Obecny stan | Stan docelowy | Dlaczego |
| --- | --- | --- | --- |
| Zestawy reguł (rulesets) | brak, lista pusta | jeden zestaw `main protection`, `target: branch`, `enforcement: active`, warunek `ref_name.include = ["~DEFAULT_BRANCH"]` | reguły w pliku w repo, widoczne w przeglądzie kodu, odtwarzalne jednym poleceniem |
| Wymuszenie pull requesta | klasyczna ochrona wymaga PR (jest `required_pull_request_reviews`) | reguła `pull_request` w zestawie | bezpośredni push na `main` zablokowany; reguła `pull_request` sama z siebie wymaga, żeby commity powstawały poza gałęzią docelową |
| Liczba zatwierdzeń | `required_approving_review_count: 1` | `required_approving_review_count: 1` | bez zmian, jedno zatwierdzenie przed scaleniem |
| Zatwierdzenie ostatniego pusha | `require_last_push_approval: false` | `require_last_push_approval: true` | osoba, która wypchnęła ostatnie zmiany, nie zatwierdza ich sama |
| Rozwiązane rozmowy | `required_conversation_resolution: true` (klasyczna) | `required_review_thread_resolution: true` (zestaw) | uwagi z recenzji nie giną przy scaleniu |
| Odrzucanie starych recenzji po pushu | `dismiss_stale_reviews: false` | `dismiss_stale_reviews_on_push: false` | bez zmian względem dzisiaj; parametr jest w API wymagany, więc musi być podany jawnie |
| Recenzja właściciela kodu | `require_code_owner_reviews: false` | `require_code_owner_review: false` | bez zmian na start. `.github/CODEOWNERS` istnieje, ale wskazuje jedynego kolaboratora, więc wymóg recenzji właściciela kodu byłby dziś nie do spełnienia. Do włączenia, gdy Bartek i Mieszko będą kolaboratorami. Parametr wymagany przez API, podany jawnie |
| Wymagane statusy | brak, `/branches/main/protection/required_status_checks` zwraca 404 | trzy konteksty z `.github/workflows/ci.yml` (patrz niżej) | scalenie tylko przy zielonym CI na trzech systemach |
| Aktualność gałęzi przed scaleniem | brak | `strict_required_status_checks_policy: true` | PR musi być przetestowany na aktualnym `main`, a nie na stanie sprzed tygodnia |
| Force push na `main` | zablokowany klasyczną ochroną (`allow_force_pushes: false`) | reguła `non_fast_forward` | to samo zabezpieczenie, ale w zestawie reguł |
| Kasowanie gałęzi `main` | zablokowane klasyczną ochroną (`allow_deletions: false`) | reguła `deletion` | to samo zabezpieczenie, ale w zestawie reguł |
| Obejście awaryjne | `enforce_admins: true`, czyli nikt nie obchodzi | `bypass_actors`: rola administratora repozytorium, `bypass_mode: always` | musi istnieć droga naprawy, gdy `main` jest zepsuty, a CI nie ma jak zazielenić |
| Kasowanie gałęzi po scaleniu | `delete_branch_on_merge: false` | `true` | scalone gałęzie same znikają, lista gałęzi zostaje czytelna |
| Metody scalania | squash, merge i rebase włączone | bez zmian | świadomie nie ograniczamy; można to zawęzić parametrem `allowed_merge_methods` |

Reguły `creation` nie dodajemy. Gałąź `main` już istnieje, więc blokada
tworzenia niczego tu nie chroni.

### Wymagane statusy, faza 1

Dokładnie te trzy napisy, przepisane z nazw zadań generowanych przez
`.github/workflows/ci.yml` (`name: lint + typecheck + test (${{ matrix.os }})`,
macierz `os: [macos-latest, ubuntu-latest, windows-latest]`):

```
lint + typecheck + test (ubuntu-latest)
lint + typecheck + test (windows-latest)
lint + typecheck + test (macos-latest)
```

Nazwa kontekstu musi się zgadzać znak w znak, ze spacjami i nawiasami. Zmiana
`name:` w workflow albo zmiana macierzy systemów rozjeżdża te napisy i każdy PR
staje na „Expected”.

---

## 2. Utworzenie zestawu reguł

Plik z ciałem żądania: `docs/engineering/ruleset-main.json`.
Polecenie uruchamiać z katalogu głównego repozytorium.

```bash
gh api --method POST repos/E4B-labs/multibot-desktop/rulesets \
  --input docs/engineering/ruleset-main.json
```

Sprawdzenie po utworzeniu (odczyt):

```bash
gh api repos/E4B-labs/multibot-desktop/rulesets
gh api repos/E4B-labs/multibot-desktop/rulesets/RULESET_ID
```

Uwaga dla Windowsa: w Git Bash ścieżka zaczynająca się od `/` bywa
przepisywana na ścieżkę dyskową i `gh` odpowiada `invalid API endpoint`.
Dlatego powyżej nie ma wiodącego ukośnika. Alternatywnie
`MSYS_NO_PATHCONV=1 gh api /repos/...`. W PowerShellu problem nie występuje.

### Sprawdź `actor_id` obejścia

W pliku JSON jest `{"actor_type": "RepositoryRole", "actor_id": 5}`. Numer 5
to wartość, którą GitHub zwykle pokazuje dla roli administratora repozytorium,
ale **nie da się jej potwierdzić żadnym odczytem przed utworzeniem zestawu**,
a dokumentacja nie publikuje tabeli numerów ról. Dlatego zaraz po utworzeniu
zestawu:

```bash
gh api repos/E4B-labs/multibot-desktop/rulesets/RULESET_ID --jq .bypass_actors
gh api repos/E4B-labs/multibot-desktop/rulesets/RULESET_ID --jq ._links.html.href
```

Otwórz ten adres i sprawdź, czy na liście obejść widnieje „Repository admin”.
Jeśli nie, podmień wpis w JSON na wariant pewny, czyli konkretne konto
właściciela (id potwierdzone odczytem `GET /users/E4B-labs`):

```json
{ "actor_type": "User", "actor_id": 275352399, "bypass_mode": "always" }
```

Na repozytorium z jednym administratorem obie wersje działają tak samo.

`bypass_mode` zostaje `always`, a nie `exempt`. Przy `exempt` GitHub w ogóle
nie uruchamia reguł dla tego aktora i **nie zapisuje wpisu w dzienniku
obejść**, co niweczy zasadę „każde obejście ma ślad”. Tryb `pull_request` z
kolei nie pozwoliłby na push naprawczy poza PR.

---

## 3. Kasowanie gałęzi po scaleniu

```bash
gh repo edit E4B-labs/multibot-desktop --delete-branch-on-merge
```

albo przez API:

```bash
gh api --method PATCH repos/E4B-labs/multibot-desktop -F delete_branch_on_merge=true
```

Ważne: `-F`, nie `-f`. `-f` wysyła napis `"true"`, a ten endpoint przyjmuje
wyłącznie wartość logiczną.

Sprawdzenie:

```bash
gh api repos/E4B-labs/multibot-desktop --jq .delete_branch_on_merge
```

---

## 4. Faza 2, czyli własne statusy MultiBota

Faza 2 dokłada dwa konteksty:

```
multibot/review
multibot/merge-gate
```

**Nie dodawaj ich, dopóki coś realnie nie wystawia tych statusów na commicie.**
Wymagany status, którego nikt nie publikuje, nie kończy się błędem, tylko
zawiesza każdy PR na wieczne „Expected - waiting for status”. Wtedy jedyną
drogą scalenia jest obejście administratora, czyli dokładnie to, czego ta
konfiguracja ma unikać. Dopóki recenzent MultiBota i bramka scalania nie chodzą
i nie wysyłają statusów, faza 2 zostaje wyłącznie tekstem w tym dokumencie i
nie ma jej w `ruleset-main.json`.

Warunek wejścia w fazę 2: na dowolnym świeżym commicie w PR widać oba konteksty
w wyniku odczytu

```bash
gh api repos/E4B-labs/multibot-desktop/commits/SHA/status --jq '.statuses[].context'
```

Sposób wykonania, gdy warunek jest spełniony:

1. W `docs/engineering/ruleset-main.json`, w regule `required_status_checks`,
   dopisz do tablicy `required_status_checks` dwa wpisy:

   ```json
   { "context": "multibot/review" },
   { "context": "multibot/merge-gate" }
   ```

   Jeśli statusy wystawia aplikacja GitHuba, dodaj w tych wpisach jej
   identyfikator, żeby nikt inny nie mógł podszyć się pod status:
   `{ "context": "multibot/review", "integration_id": ID_APLIKACJI }`.

2. Ustal identyfikator zestawu:

   ```bash
   gh api repos/E4B-labs/multibot-desktop/rulesets \
     --jq '.[] | select(.name=="main protection") | .id'
   ```

3. Wyślij zaktualizowany plik metodą PUT:

   ```bash
   gh api --method PUT repos/E4B-labs/multibot-desktop/rulesets/RULESET_ID \
     --input docs/engineering/ruleset-main.json
   ```

PUT **podmienia całą tablicę `rules`**, nie dokłada różnicy. Dlatego wysyła się
pełny plik ze wszystkimi regułami fazy 1 plus dwiema nowymi, a nie sam fragment.

---

## 5. Współistnienie z klasyczną ochroną gałęzi

Klasyczna ochrona `main` i zestaw reguł działają jednocześnie i **obowiązuje
suma, czyli wersja ostrzejsza**. Z tego wynikają dwie rzeczy:

- Dopóki klasyczna ochrona istnieje z `enforce_admins: true`, **obejście
  awaryjne nie działa w ogóle**. Ani `gh pr merge --admin`, ani `bypass_actors`
  z zestawu nie przepchną niczego, bo klasyczna reguła obowiązuje administratora
  tak samo jak resztę. Procedura ratunkowa z punktu 6 ma sens dopiero po
  skasowaniu klasycznej ochrony.
- Dwa źródła prawdy o tej samej gałęzi to proszenie się o pomyłkę. Docelowo ma
  zostać jedno, czyli zestaw reguł.

Kolejność migracji:

1. Utwórz zestaw reguł (punkt 2). Klasyczna ochrona zostaje na razie.
2. Załóż testowy PR z drobną zmianą i sprawdź, że: bezpośredni push na `main`
   jest odrzucany, CI musi być zielone na trzech systemach, przycisk scalania
   jest zablokowany bez zatwierdzenia, a po scaleniu gałąź znika.
3. Dopiero gdy testowy PR zachował się poprawnie, skasuj klasyczną ochronę.

Podgląd klasycznej ochrony (odczyt):

```bash
gh api repos/E4B-labs/multibot-desktop/branches/main/protection
gh api repos/E4B-labs/multibot-desktop/branches/main/protection/required_pull_request_reviews
```

Skasowanie klasycznej ochrony, dopiero po kroku 2:

```bash
gh api --method DELETE repos/E4B-labs/multibot-desktop/branches/main/protection
```

Po skasowaniu jeszcze raz odczytaj `rulesets` i zrób jeden PR kontrolny.
Skasowanie klasycznej ochrony bez działającego zestawu zostawia `main` zupełnie
odsłonięty.

### Jeden człowiek a wymóg jednego zatwierdzenia

W repozytorium jest dokładnie jeden współpracownik, `E4B-labs`, z rolą
administratora. Przy `required_approving_review_count: 1` i włączonym
`require_last_push_approval` właściciel **nie scali własnego PR-a**, bo GitHub
nie pozwala zatwierdzić własnych zmian. Obejście awaryjne stałoby się wtedy
zwykłą, codzienną drogą, a to najgorszy możliwy skutek tej konfiguracji.
Wyjścia, do wyboru: dodać drugiego człowieka lub drugie konto jako recenzenta,
wpiąć aplikację, która zatwierdza PR-y (recenzent MultiBota z uprawnieniem do
recenzji), albo świadomie ustawić `required_approving_review_count: 0` i
opierać bramkę na wymaganych statusach. Wartość 1 zostaje w pliku zgodnie z
przyjętym założeniem, ale przed włączeniem zestawu trzeba wybrać jedną z tych
dróg.

---

## 6. Obejście awaryjne i procedura naprawy

Obejście przysługuje wyłącznie właścicielowi, przez rolę administratora
repozytorium w `bypass_actors`. Nie jest to normalna droga scalania. Służy
jednej sytuacji: `main` jest zepsuty, a CI nie ma jak zazielenić, bo psuje się
sama bramka (padnięty runner, zepsuty workflow, kontekst statusu, którego nikt
już nie wystawia).

Zanim sięgniesz po obejście, sprawdź tańsze wyjścia:

- czy da się naprawić zwykłym PR-em, nawet jeśli CI trwa długo,
- czy wymagany kontekst nadal istnieje (`gh api repos/.../commits/SHA/status`),
- czy wystarczy ponowne uruchomienie zadania CI.

Procedura, gdy obejście jest jedynym wyjściem:

1. Załóż PR z naprawą mimo wszystko, żeby zmiana miała opis i ślad.
2. Scal z pominięciem reguł: `gh pr merge NUMER --admin`. Jeśli PR jest
   niemożliwy, dopiero wtedy push naprawczy prosto na `main`.
3. Zaraz po naprawie **zapisz obejście**: komentarz w tym PR-u albo osobne
   zgłoszenie, zawierające co się zepsuło, dlaczego CI nie mogło przejść, co
   dokładnie zostało wypchnięte i kto to zrobił.
4. Napraw przyczynę, żeby następnym razem obejście nie było potrzebne. Jeśli
   powodem był wymagany status, którego nikt nie wystawia, usuń ten kontekst z
   `ruleset-main.json` i wyślij PUT z punktu 4.

Każde użycie obejścia bez wpisu z punktu 3 traktujemy jak awarię procesu, nie
jak drobiazg.

---

## 7. Rozbieżności między opisem założeń a dokumentacją GitHuba

- „Autor nie może zatwierdzić własnego PR-a” nie ma osobnego parametru w
  zestawach reguł. GitHub blokuje samozatwierdzenie z zasady, a najbliższym
  ustawieniem jest `require_last_push_approval`, opisane jako „ostatni
  recenzowalny push musi zatwierdzić ktoś inny niż osoba, która go wypchnęła”.
  W pliku ustawione na `true`.
- Parametry `dismiss_stale_reviews_on_push` i `require_code_owner_review` są w
  dokumentacji oznaczone jako wymagane w regule `pull_request`, mimo że
  założenia o nich nie wspominały. Pominięcie ich kończy się odpowiedzią 422,
  więc są podane jawnie z wartością `false`, zgodną z dzisiejszą klasyczną
  ochroną.
- Numer roli administratora w `bypass_actors.actor_id` nie jest udokumentowany
  i nie da się go potwierdzić odczytem przed utworzeniem zestawu. Patrz punkt 2.

Źródła: `https://docs.github.com/en/rest/repos/rules` (parametry tworzenia i
aktualizacji zestawu, reguły `pull_request`, `required_status_checks`,
`non_fast_forward`, `deletion`, `bypass_actors`, `conditions.ref_name`) oraz
`https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository`
(kto może dostać obejście). Stan repozytorium: odczyty `gh api` z 2026-09-02.
