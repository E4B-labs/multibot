// multibot: koperty, którymi serwer opakowuje wiadomości krążące MIĘDZY botami.
// Serwer dokleja je celowo — bez nich model nie wie, że pisze do niego kolega,
// a nie użytkownik (server/index.ts, `prefixed` przy ask_bot i `[Delegation
// from @…]` przy delegacji). Dlatego NIE usuwamy ich u źródła: silnik ma
// dostawać komplet. Usuwamy je wyłącznie przy WYŚWIETLANIU, bo w dymku surowa
// koperta jest długa, angielska i nic użytkownikowi nie mówi.
//
// Dwa wyjścia, bo dymek nadawcy i dymek odbiorcy renderują się inaczej:
//   - `parsePeerEnvelope` oddaje nadawcę osobno od treści. Bierze je dymek
//     roli „user", który leci czystym tekstem bez markdowna — nadawcę rysuje
//     tam plakietka z awatarem (components/PeerBadge.tsx).
//   - `formatPeerEnvelope` skleja `@Nazwa treść` dla ścieżek markdownowych,
//     gdzie `@Nazwa` łapie się na wtyczkę wzmianek z ChatMarkdown i sama
//     staje się pigułką z awatarem.
// W obu wypadkach po nazwie NIE ma dwukropka — treść idzie od razu.

/** Koperta rozmowy bot↔bot: `[Message from @X, another bot in this MultiBot
 * workspace. Reply to them.]` + pusta linia + treść. */
const PEER_MESSAGE = /^\[Message from @(.+?), another bot in this MultiBot workspace\. Reply to them\.\]\s*/;

/** Koperta delegacji: `[Delegation from @X] treść`. */
const DELEGATION = /^\[Delegation from @(.+?)\]\s*/;

export type PeerEnvelope = { from: string; body: string };

/**
 * Rozbiera kopertę na nadawcę i treść. `null`, gdy wiadomość nie jest kopertą —
 * funkcja biegnie po KAŻDEJ wiadomości w czacie, więc nie może niczego psuć
 * przy okazji.
 */
export function parsePeerEnvelope(text: string): PeerEnvelope | null {
  for (const pattern of [PEER_MESSAGE, DELEGATION]) {
    const match = pattern.exec(text);
    if (!match) continue;
    return { from: match[1], body: text.slice(match[0].length) };
  }
  return null;
}

/**
 * Zamienia kopertę na `@Nazwa treść`. Tekst bez koperty wraca nietknięty.
 * Sama koperta bez treści zdarza się przy pustym pytaniu — wtedy zostaje samo
 * `@Nazwa`, bez wiszącej spacji.
 */
export function formatPeerEnvelope(text: string): string {
  const envelope = parsePeerEnvelope(text);
  if (!envelope) return text;
  return envelope.body ? `@${envelope.from} ${envelope.body}` : `@${envelope.from}`;
}
