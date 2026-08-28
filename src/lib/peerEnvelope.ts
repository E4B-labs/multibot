// multibot: koperty, którymi serwer opakowuje wiadomości krążące MIĘDZY botami.
// Serwer dokleja je celowo — bez nich model nie wie, że pisze do niego kolega,
// a nie użytkownik (server/index.ts, `prefixed` przy ask_bot i `[Delegation
// from @…]` przy delegacji). Dlatego NIE usuwamy ich u źródła: silnik ma
// dostawać komplet. Usuwamy je wyłącznie przy WYŚWIETLANIU, bo w dymku surowa
// koperta jest długa, angielska i nic użytkownikowi nie mówi.
//
// Wynik ma kształt `@Nazwa: treść`. W dymkach bota `@Nazwa` łapie się jeszcze
// na wtyczkę wzmianek z ChatMarkdown i renderuje jako pigułka z awatarem.

/** Koperta rozmowy bot↔bot: `[Message from @X, another bot in this MultiBot
 * workspace. Reply to them.]` + pusta linia + treść. */
const PEER_MESSAGE = /^\[Message from @(.+?), another bot in this MultiBot workspace\. Reply to them\.\]\s*/;

/** Koperta delegacji: `[Delegation from @X] treść`. */
const DELEGATION = /^\[Delegation from @(.+?)\]\s*/;

/**
 * Zamienia kopertę na `@Nazwa: treść`. Tekst bez koperty wraca nietknięty —
 * funkcja biegnie po KAŻDEJ wiadomości w czacie, więc nie może niczego psuć
 * przy okazji.
 */
export function formatPeerEnvelope(text: string): string {
  for (const pattern of [PEER_MESSAGE, DELEGATION]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const name = match[1];
    const body = text.slice(match[0].length);
    // Sama koperta bez treści zdarza się przy pustym pytaniu — wtedy dwukropek
    // wisiałby w powietrzu.
    return body ? `@${name}: ${body}` : `@${name}`;
  }
  return text;
}
