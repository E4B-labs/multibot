// multibot: bieżący stan floty doklejany do KAŻDEJ tury bota, żeby bot wiedział,
// kto jeszcze pracuje i czy jest wolny — bez wołania `list_bots`.
//
// Dlaczego w treści tury, a nie w prompcie systemowym: prompt systemowy ma
// w tym repo dwie ścieżki. Drivery CLI dostają pole `system` z `sendTurn`, ale
// driver `slafy` je IGNORUJE — do silnika idzie tylko `{ message, model }`,
// a tożsamość bota żyje w engine/server/bots.py. Blok w prompcie systemowym
// dotarłby więc do części floty i po cichu ominął resztę. Treść tury przechodzi
// tą samą drogą u wszystkich, więc jedno miejsce wystarcza.
//
// To samo rozwiązanie, którym idą już wiadomości w pokojach współpracy
// (server/index.ts, „wiadomości innych botów jadą W TREŚCI promptu").
//
// Blok jest przeliczany przy każdej turze, bo `busy` zmienia się w trakcie
// pracy floty — zapamiętany raz byłby gorszy niż żaden: wyglądałby na aktualny.

export type FleetBot = {
  id: string;
  name: string;
  busy?: boolean;
  hidden?: boolean;
  title?: string;
  description?: string;
  modelSelection?: { model?: string };
};

/** Jedna linijka na bota: kto to, czym się zajmuje, na czym stoi i czy wolny. */
function line(bot: FleetBot): string {
  const model = bot.modelSelection?.model;
  const persona = [bot.title, bot.description].filter(Boolean).join(" — ");
  const head = `- ${bot.name} (id: ${bot.id}${model ? `, model: ${model}` : ""})`;
  const state = bot.busy ? "working on a turn right now" : "idle";
  return persona ? `${head} — ${state} — ${persona}` : `${head} — ${state}`;
}

/**
 * Stan pozostałych botów w chwili tej tury. Pusty łańcuch, gdy nie ma o kim
 * mówić — wtedy nie doklejamy nagłówka, który opisywałby pustkę.
 *
 * Boty ukryte pomijamy: nie są widoczne dla użytkownika, więc odwoływanie się
 * do nich myliłoby i bota, i czytającego transkrypt.
 */
export function fleetStatusBlock(bots: readonly FleetBot[], selfId: string): string {
  const peers = bots.filter((bot) => bot.id !== selfId && !bot.hidden);
  if (!peers.length) return "";
  return [
    "[Fleet status — refreshed for this turn, no need to call list_bots for it]",
    ...peers.map(line),
    "Use it to decide whom to involve: a bot marked idle can take work now, one working on a turn will answer late.",
  ].join("\n");
}
