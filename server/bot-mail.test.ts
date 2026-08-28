import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BotMailQueue, BotMailStore } from "./bot-mail.ts";

describe("BotMailStore", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("keeps one durable thread for both directions", () => {
    const store = new BotMailStore();
    const first = store.append({ from: "ala", to: "bob", text: "ping" });
    const second = store.append({ from: "bob", to: "ala", text: "pong", replyToId: first.id });

    expect(store.list()).toHaveLength(1);
    expect(store.get("mail-ala__bob")?.messages).toHaveLength(2);
    const thread = store.list()[0]!;
    expect(thread.bot_ids).toEqual(["ala", "bob"]);
    expect(thread.messages).toMatchObject([
      { from: "ala", to: "bob", text: "ping", status: "delivered" },
      { from: "bob", to: "ala", text: "pong", replyToId: first.id },
    ]);
    expect(store.forBot("cyd")).toEqual([]);
    expect(second.replyToId).toBe(first.id);
  });

  it("survives a new store instance and removes bot mail with bot", () => {
    const store = new BotMailStore();
    const message = store.append({ from: "ala", to: "bob", text: "remember this", status: "queued", depth: 1 });
    const reloaded = new BotMailStore();
    expect(reloaded.get(`mail-ala__bob`)?.messages[0]?.id).toBe(message.id);
    expect(reloaded.get(`mail-ala__bob`)?.messages[0]?.depth).toBe(1);
    expect(existsSync(join(DATA_DIR, "bot-mail.json"))).toBe(true);
    expect(reloaded.deleteBot("bob")).toBe(1);
    expect(new BotMailStore().list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bot-mail.json"), "utf8"))).toEqual([]);
  });
});

describe("BotMailQueue", () => {
  it("is FIFO per target and drops deleted senders", () => {
    const queue = new BotMailQueue();
    queue.push({ messageId: "1", fromBotId: "ala", toBotId: "bob", text: "one", depth: 0 });
    queue.push({ messageId: "2", fromBotId: "cyd", toBotId: "bob", text: "two", depth: 0 });
    expect(queue.take("bob")?.map((message) => message.messageId)).toEqual(["1", "2"]);
    queue.push({ messageId: "3", fromBotId: "ala", toBotId: "bob", text: "three", depth: 0 });
    queue.deleteBot("ala");
    expect(queue.take("bob")).toBeNull();
  });
});
