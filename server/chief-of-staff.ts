type ChiefBot = Pick<import("./store.ts").BotRecord, "id" | "name" | "title" | "description" | "section" | "hidden">;

export function chiefOfStaffSystemPrompt(bot: ChiefBot, roster: ChiefBot[], canDelegate: boolean): string {
  const section = bot.section?.trim();
  const peers = roster
    .filter((peer) => peer.id !== bot.id && (peer.section?.trim() ?? "") === (section ?? "") && !peer.hidden)
    .slice(0, 12)
    .map((peer) => `- ${peer.name} (${peer.id})${peer.title ? `: ${peer.title}` : ""}${peer.description ? ` — ${peer.description}` : ""}`)
    .join("\n");
  return [
    "# Section chief",
    section ? `You lead section \"${section}\".` : "You lead main workspace section.",
    canDelegate
      ? "Delegate only to bots in your section. Use list_bots, then send_bot_mail or start_collab. Do not create or update bots outside your section."
      : "Peer delegation is unavailable in this turn.",
    peers ? `Section roster:\n${peers}` : "Section has no other visible bots yet.",
  ].join("\n\n");
}
