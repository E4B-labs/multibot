import type { Bot } from "@/state/store";

/** Search bot names, roles and mascot names for the sidebar/palette face filter. */
export function autocompleteBots(query: string, bots: Bot[], limit = 6): Bot[] {
  const q = query.trim().toLocaleLowerCase();
  return bots
    .filter((bot) => !bot.hidden)
    .map((bot, index) => ({ bot, index, score: q ? [bot.name, bot.title, bot.description, bot.mascotShape, bot.mascotExpression].filter(Boolean).join(" ").toLocaleLowerCase().includes(q) ? 0 : 1 : 0 }))
    .filter((row) => !q || row.score === 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.bot);
}
