// multibot: runda czatu grupowego. Wydzielona z groups.send w index.ts, żeby
// dało się jednostkowo przybić RÓWNOLEGŁOŚĆ — sekwencja trzymała odpowiedź
// HTTP przez sumę tur wszystkich botów (N × do 4 min), równoległość przez
// czas najwolniejszego. Kolejność wyników jest stała (kolejność grupy),
// niezależnie od tego, który bot skończył pierwszy.
export async function runGroupRound<T extends { id: string }>(
  bots: T[],
  ask: (bot: T) => Promise<string>,
): Promise<Array<{ bot_id: string; reply: string }>> {
  const replies = await Promise.all(bots.map(ask));
  return bots.map((bot, i) => ({ bot_id: bot.id, reply: replies[i] }));
}
