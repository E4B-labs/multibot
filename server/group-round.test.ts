import { describe, expect, it } from "vitest";

import { runGroupRound } from "./group-round.ts";

describe("group round", () => {
  it("dispatches every bot before any reply settles (parallel, not sequential)", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (reply: string) => void>();
    const bots = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const round = runGroupRound(bots, (bot) => {
      started.push(bot.id);
      return new Promise((resolve) => resolvers.set(bot.id, resolve));
    });
    // sekwencja wystartowałaby "b" dopiero po odpowiedzi "a" — równoległość
    // ma wszystkie tury w locie zanim jakakolwiek się rozstrzygnie
    expect(started).toEqual(["a", "b", "c"]);
    // odpowiedzi wracają w odwrotnej kolejności — wynik trzyma porządek grupy
    resolvers.get("c")!("reply c");
    resolvers.get("b")!("reply b");
    resolvers.get("a")!("reply a");
    expect(await round).toEqual([
      { bot_id: "a", reply: "reply a" },
      { bot_id: "b", reply: "reply b" },
      { bot_id: "c", reply: "reply c" },
    ]);
  });
});
