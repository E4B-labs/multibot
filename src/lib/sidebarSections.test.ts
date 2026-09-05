import { describe, expect, it } from "vitest";

import { moveSectionTo, orderSections, sectionRows } from "./sidebarSections";

describe("orderSections", () => {
  it("puts saved order first and appends new sections at the end", () => {
    const names = ["Workers", "GitHub", "Automations"];
    expect(orderSections(names, ["GitHub", "Workers"])).toEqual(["GitHub", "Workers", "Automations"]);
  });

  it("drops saved names that no longer exist, trims and dedupes", () => {
    expect(orderSections([" GitHub ", "GitHub", "", null, undefined], ["Gone", "GitHub", "GitHub"]))
      .toEqual(["GitHub"]);
  });

  it("falls back to first-appearance order without a saved order", () => {
    expect(orderSections(["b", "a", "b"])).toEqual(["b", "a"]);
  });
});

describe("moveSectionTo", () => {
  const order = ["a", "b", "c"];

  it("moves a section up and down", () => {
    expect(moveSectionTo(order, "c", 1)).toEqual(["a", "c", "b"]);
    expect(moveSectionTo(order, "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("leaves the order alone outside the list", () => {
    expect(moveSectionTo(order, "a", -1)).toEqual(order);
    expect(moveSectionTo(order, "c", 3)).toEqual(order);
    expect(moveSectionTo(order, "zzz", 0)).toEqual(order);
  });
});

describe("sectionRows", () => {
  const bots = [
    { id: "b1" },
    { id: "b2", section: "GitHub" },
    { id: "b3", section: " GitHub " },
    { id: "b4", section: "Workers" },
  ];
  const groups = [{ id: "g1" }, { id: "g2", section: "GitHub" }];

  it("splits bots and groups into the same sections", () => {
    const rows = sectionRows(bots, groups, ["Workers"]);
    expect(rows.unsectioned.bots.map((b) => b.id)).toEqual(["b1"]);
    expect(rows.unsectioned.groups.map((g) => g.id)).toEqual(["g1"]);
    expect(rows.sections.map((s) => s.name)).toEqual(["Workers", "GitHub"]);
    expect(rows.sections[1].bots.map((b) => b.id)).toEqual(["b2", "b3"]);
    expect(rows.sections[1].groups.map((g) => g.id)).toEqual(["g2"]);
  });

  it("renders no section when nothing lives in it", () => {
    expect(sectionRows([{ id: "b1", section: "" }], [], ["Ghost"]).sections).toEqual([]);
  });
});
