import { describe, expect, it } from "vitest";
import { groupAvatarSplit, groupRowTitle } from "./groupRow";

describe("groupRowTitle", () => {
  it("joins member names with a comma", () => {
    expect(groupRowTitle(["Szef sztabu", "Nowy"])).toBe("Szef sztabu, Nowy");
  });

  it("is empty for a group with no known members", () => {
    expect(groupRowTitle([])).toBe("");
  });
});

describe("groupAvatarSplit", () => {
  it("shows at most two avatars and counts the rest", () => {
    expect(groupAvatarSplit(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b"], overflow: 2 });
  });

  it("counts unknown bots via the total member count", () => {
    expect(groupAvatarSplit(["a", "b"], 2, 5)).toEqual({ shown: ["a", "b"], overflow: 3 });
  });

  it("never returns negative overflow", () => {
    expect(groupAvatarSplit(["a", "b"], 2, 1)).toEqual({ shown: ["a", "b"], overflow: 0 });
  });
});
