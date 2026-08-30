import type { BotRecord } from "./store.ts";
import type { IdentityActor } from "./identity.ts";

export type BotVisibility = "team" | "private";

export function botVisibility(bot: BotRecord): BotVisibility {
  return bot.visibility === "private" ? "private" : "team";
}

/** Private means owner-only. Server owner is not a data-plane superuser. */
export function canReadBot(bot: BotRecord | null, actor: IdentityActor | null): boolean {
  if (!bot || !actor) return false;
  return botVisibility(bot) === "team" || bot.ownerId === actor.userId;
}

/** Team bots are collaboratively editable. Private bots remain owner-only. */
export function canManageBot(bot: BotRecord | null, actor: IdentityActor | null): boolean {
  return canReadBot(bot, actor) && (botVisibility(bot!) === "team" || bot!.ownerId === actor!.userId);
}

export function canBotContact(source: BotRecord | null, target: BotRecord | null): boolean {
  if (!source || !target) return false;
  if (botVisibility(source) === "team" && botVisibility(target) === "team") return true;
  return botVisibility(source) === "private" && botVisibility(target) === "private" && source.ownerId === target.ownerId;
}

export function canUseFullAccess(bot: BotRecord | null, actor: IdentityActor | null): boolean {
  // Boty team są wspólne dla każdego zalogowanego członka workspace. Prywatne
  // boty nadal działają wyłącznie w trybie akceptacji, także u właściciela.
  return Boolean(bot && actor && botVisibility(bot) === "team");
}
