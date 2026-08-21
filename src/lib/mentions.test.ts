import { describe, expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import { mentionPlugins, remarkMentions } from "./mentions";

const bots = [{ name: "Content Agent" }, { name: "New Bot" }];

/** To, co robi unified z listą wtyczek: krotka rozkłada się na atacher i opcje. */
function runPlugins(list: unknown[], tree: any) {
  for (const entry of list) {
    const [attacher, options] = Array.isArray(entry) ? entry : [entry, undefined];
    if (attacher === remarkGfm) continue; // gfm wymaga prawdziwego procesora
    const transformer = (attacher as (o: any) => any)(options);
    transformer(tree);
  }
  return tree;
}

const paragraph = (value: string) => ({ type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] });
const kinds = (tree: any) => tree.children[0].children.map((c: any) => c.type);
const mentionNames = (tree: any) =>
  tree.children[0].children.filter((c: any) => c.type === "mention").map((c: any) => c.data.hProperties.dataMention);

describe("wzmianki @bot", () => {
  it("przechodzi przez listę wtyczek tak, jak wywoła ją unified", () => {
    // Regres: lista miała `remarkMentions({ bots })`, więc unified dostawał
    // gotowy transformer i odpalał go jako atacher, bez drzewa — cała
    // aplikacja padała na starcie z „Cannot read properties of undefined".
    const tree = runPlugins(mentionPlugins(remarkGfm, bots), paragraph("hej @New Bot zrób to"));
    expect(kinds(tree)).toEqual(["text", "mention", "text"]);
    expect(mentionNames(tree)).toEqual(["New Bot"]);
  });

  it("bez botów nie dokłada wtyczki wzmianek", () => {
    expect(mentionPlugins(remarkGfm, [])).toEqual([remarkGfm]);
  });

  it("łapie wzmiankę na początku i kilka w jednym zdaniu", () => {
    const tree = paragraph("@Content Agent i @New Bot razem");
    remarkMentions({ bots })(tree);
    expect(mentionNames(tree)).toEqual(["Content Agent", "New Bot"]);
  });

  it("nie tyka adresu pocztowego ani nazwy z myślnikiem", () => {
    const tree = paragraph("pisz na ktos@New Bot-owy.pl, nie tutaj");
    remarkMentions({ bots })(tree);
    expect(kinds(tree)).toEqual(["text"]);
  });

  it("nie używa lookbehind — starsze WebView Androida rzucają na nim SyntaxError", () => {
    const source = String(remarkMentions({ bots }));
    expect(source.includes("(?<")).toBe(false);
  });
});
