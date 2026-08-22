import { describe, expect, it } from "vitest";

import { remarkBrackets } from "./brackets";
import { remarkSkillRefs } from "./skillRefs";

const root = (child: any) => ({ type: "root", children: [{ type: "paragraph", children: [child] }] });
const children = (tree: any) => tree.children[0].children;

describe("quoted bracket formatting", () => {
  it("renders quoted brackets as italic and leaves bare brackets alone", () => {
    const quoted = root({ type: "text", value: "before '[text]' after" });
    remarkBrackets()(quoted);
    expect(children(quoted)).toEqual([
      { type: "text", value: "before " },
      { type: "emphasis", children: [{ type: "text", value: "text" }] },
      { type: "text", value: " after" },
    ]);

    const bare = root({ type: "text", value: "[text]" });
    remarkBrackets()(bare);
    expect(children(bare)).toEqual([{ type: "text", value: "[text]" }]);
  });

  it("renders markdown-wrapped quoted brackets as bold", () => {
    const tree = root({ type: "emphasis", children: [{ type: "text", value: "'[text]'" }] });
    remarkBrackets()(tree);
    expect(children(tree)).toEqual([
      { type: "strong", children: [{ type: "text", value: "text" }] },
    ]);
  });
});

describe("skill references", () => {
  it("marks every known skill name without matching inside another word", () => {
    const tree = root({ type: "text", value: "Use Grill Me, C++ Review and preGrill Me." });
    remarkSkillRefs({ skills: ["Grill Me", "C++ Review"] })(tree);
    const refs = children(tree)
      .filter((node: any) => node.type === "skillRef")
      .map((node: any) => node.data.hProperties.dataSkillRef);
    expect(refs).toEqual(["Grill Me", "C++ Review"]);
  });
  it("łapie nazwę w polskich cudzysłowach, tak jak bot ją pisze w zdaniu", () => {
    // Zdanie prosto z czatu: „Umiejętność „Grill Me" została utworzona…".
    // Cudzysłów typograficzny musi liczyć się jako granica słowa, inaczej
    // pigułka nie powstaje dokładnie tam, gdzie użytkownik jej oczekuje.
    const tree = root({ type: "text", value: "Umiejętność „Grill Me” została utworzona i będę jej używać." });
    remarkSkillRefs({ skills: ["Grill Me"] })(tree);
    const refs = children(tree)
      .filter((node: any) => node.type === "skillRef")
      .map((node: any) => node.data.hProperties.dataSkillRef);
    expect(refs).toEqual(["Grill Me"]);
  });
});
