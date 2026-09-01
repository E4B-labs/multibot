import { describe, expect, it } from "vitest";
import { combineQueuedMessages, QueuedUserMessages } from "./queued-turns.ts";

describe("combineQueuedMessages", () => {
  it("pojedyncza wiadomość idzie bez prefiksu i numeracji", () => {
    expect(combineQueuedMessages(["kup mleko"])).toBe("kup mleko");
  });

  it("wiele wiadomości dostaje prefiks i numerowaną listę", () => {
    const combined = combineQueuedMessages(["pierwsza", "druga", "trzecia"]);
    expect(combined).toContain("several messages");
    expect(combined).toContain("1. pierwsza");
    expect(combined).toContain("2. druga");
    expect(combined).toContain("3. trzecia");
    // kolejność zachowana
    expect(combined.indexOf("1.")).toBeLessThan(combined.indexOf("2."));
  });

  it("pusta kolejka daje pusty string", () => {
    expect(combineQueuedMessages([])).toBe("");
  });
});

describe("QueuedUserMessages", () => {
  it("push odkłada FIFO, take zwraca wszystko i czyści", () => {
    const q = new QueuedUserMessages();
    q.push("b1", "a");
    q.push("b1", "b");
    expect(q.take("b1")).toEqual(["a", "b"]);
    expect(q.take("b1")).toBeNull();
  });

  it("kolejki botów są niezależne", () => {
    const q = new QueuedUserMessages();
    q.push("b1", "a");
    q.push("b2", "x");
    expect(q.take("b1")).toEqual(["a"]);
    expect(q.take("b2")).toEqual(["x"]);
  });

  it("take nieistniejącego bota = null", () => {
    expect(new QueuedUserMessages().take("ghost")).toBeNull();
  });
});
