# Gates: UI/UX paczka 0.1.44 (avatar, powłoka, grupy, kolejka, composer, pokój, prompt)

Scope: wszystkie 7 pozycji celu + wydanie desktop 0.1.44.

- [x] G1: Avatar agenta nad composereem mniejszy (77→60px, mt dopasowane)
  CHECK: rg -n "size-\[60px\]|size=\{60\}|md:mt-\[68px\]" src/components/Composer.tsx
  EXPECT: 3 trafienia, zero "size-\[77px\]"
- [x] G2: Niebieska powłoka zniknęła — brak pingu accent wokół avatara w nagłówku czatu
  CHECK: rg -n "header-avatar-ping|border-accent/35" src/components/ChatView.tsx
  EXPECT: brak trafień
- [x] G3: Przycisk Stop/kwadrat usunięty z nagłówka i composera
  CHECK: rg -n "Square" src/components/ChatView.tsx src/components/Composer.tsx
  EXPECT: brak trafień
- [x] G4: Przycisk Send dodany po prawej, voice+effort na lewo od niego
  CHECK: rg -n "ArrowUp|Wyślij|Send\"" src/components/Composer.tsx
  EXPECT: przycisk Send za mikiem w JSX
- [x] G5: Kolejka wiadomości: POST przy zajęcym bocie zapisuje bubel + kolejkę; drain skleja i odpala jedną turę
  CHECK: npx vitest run server/queued-turns.test.ts
  EXPECT: testy przechodzą (combine + FIFO clear)
- [x] G6: Drain podłączony we wszystkich 3 miejscach końca tury
  CHECK: rg -n "drainQueuedUserMessages" server/index.ts
  EXPECT: >=4 trafienia (def + turn.completed + error + interrupt)
- [x] G7: "New group" usunięte z menu +; pusty klik LPM w sidebar otwiera formularz grupy
  CHECK: rg -n "Nowa grupa|New group" src/components/Sidebar.tsx
  EXPECT: tylko etykiety wewnątrz formularza/create, zero przycisków otwierających
- [x] G8: Wiersz grupy lokalnej: pigułka + chevron + nazwa + kółka-inicjały bez łapki/żółtego; kosz na hover
  CHECK: rg -n "group-hover:opacity-100|rounded-full bg-raised/50" src/components/Sidebar.tsx
  EXPECT: trafienia w LocalGroupsSection
- [x] G9: Nagłówek pokoju bot-vs-bot: [avatar] NazwaA ⇄ [avatar] NazwaB; nieznany id ≠ surowy UUID
  CHECK: rg -n "ArrowLeftRight|deleted bot|usunięty bot" src/components/RoomPanel.tsx
  EXPECT: trafienia; brak nameOf fallbacku zwracającego botId
- [x] G10: System prompt silnika mówi wprost o tworzeniu agentów (create_agent)
  CHECK: rg -n "create_agent" engine/server/bots.py
  EXPECT: >=1 trafienie w bloku tożsamości
- [x] G11: Bramki repo: tsc -b czysto, vitest całość, vite build, tsc server.build
  CHECK: npx tsc -b; npx vitest run; npx vite build; npx tsc -p tsconfig.server.build.json
  EXPECT: exit 0 wszędzie, vitest 0 fail
- [x] G12: Wydanie desktop 0.1.44 na GitHub Releases (exe + blockmap + latest.yml, Latest)
  CHECK: gh release view v0.1.44 --repo E4B-labs/multibot --json tagName,assets
  EXPECT: tag v0.1.44, 3 assety
