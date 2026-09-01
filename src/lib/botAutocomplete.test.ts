import { describe, expect, it } from "vitest";
import { autocompleteBots } from "./botAutocomplete";

const bot = (id: string, name: string, shape: string, hidden = false) => ({ id, name, mascotShape: shape, hidden, title: "", description: "", messages: [], color: "blue", notifications: true, unread: false, threadId: id, modelSelection: { instanceId: "local", model: "default" } } as any);

describe("bot autocomplete", () => {
  it("matches face shape and excludes hidden bots", () => {
    expect(autocompleteBots("leaf", [bot("1", "Alpha", "cursor"), bot("2", "Beta", "leaf"), bot("3", "Hidden", "leaf", true)]).map((item) => item.id)).toEqual(["2"]);
  });
});
