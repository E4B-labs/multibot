import { describe, expect, it } from "vitest";

import { canBotContact, canReadBot, canUseFullAccess } from "./acl.ts";
import type { BotRecord } from "./store.ts";

const bot = (id: string, visibility: "team" | "private", ownerId?: string): BotRecord => ({
  id,
  threadId: id,
  name: id,
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "test", model: "test" },
  resumeCursors: {},
  visibility,
  ownerId,
  createdAt: 0,
});

const owner = { userId: "u1", username: "owner", displayName: "Owner", role: "owner" as const };
const member = { userId: "u2", username: "member", displayName: "Member", role: "member" as const };

describe("v2 bot ACL", () => {
  it("keeps private bots owner-only and separates bot mail scopes", () => {
    const privateOwner = bot("private-owner", "private", "u1");
    const privateMember = bot("private-member", "private", "u2");
    const team = bot("team", "team");

    expect(canReadBot(privateOwner, owner)).toBe(true);
    expect(canReadBot(privateOwner, member)).toBe(false);
    expect(canReadBot(privateOwner, { ...owner, role: "owner", userId: "server-owner" })).toBe(false);
    expect(canBotContact(privateOwner, privateMember)).toBe(false);
    expect(canBotContact(privateOwner, team)).toBe(false);
    expect(canBotContact(team, team)).toBe(true);
  });

  it("allows every workspace member Full Access on Team bots", () => {
    expect(canUseFullAccess(bot("team", "team"), owner)).toBe(true);
    expect(canUseFullAccess(bot("team", "team"), member)).toBe(true);
    expect(canUseFullAccess(bot("private", "private", "u1"), owner)).toBe(false);
  });
});
