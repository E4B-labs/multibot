// brackets: '[text]' -> italic (<em>), *'[text]'* -> bold (<strong>)
// Mirrors mentionPlugins pattern: walk tree, split text nodes.
export function remarkBrackets() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        // emphasis wrapping a quoted bracket -> strong (bold)
        if (child.type === "emphasis" && child.children?.length === 1 && child.children[0].type === "text") {
          const v: string = child.children[0].value ?? "";
          const m = /^['"\u2018\u2019\u201C\u201D]\[([^\]]+)\]['"\u2018\u2019\u201C\u201D]$/.exec(v);
          if (m) {
            node.children.splice(i, 1, {
              type: "strong",
              children: [{ type: "text", value: m[1] }],
            });
            continue;
          }
        }
        if (child.type === "text") {
          const parts = splitText(child.value);
          if (parts.length !== 1 || parts[0].type !== "text") {
            node.children.splice(i, 1, ...parts);
            continue;
          }
        }
        // recurse, but skip code
        if (child.type !== "code" && child.type !== "inlineCode") walk(child);
      }
    };

    // '[text]' with straight or curly quotes -> italic
    const QUOTE = `['"\u2018\u2019\u201C\u201D]`;
    const re = new RegExp(`${QUOTE}\\[([^\\]]+)\\]${QUOTE}`, "g");
    const splitText = (value: string): any[] => {
      const out: any[] = [];
      let last = 0;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(value))) {
        const idx = m.index;
        const inner = m[1];
        if (idx > last) out.push({ type: "text", value: value.slice(last, idx) });
        out.push({ type: "emphasis", children: [{ type: "text", value: inner }] });
        last = idx + m[0].length;
      }
      if (!out.length) return [{ type: "text", value }];
      if (last < value.length) out.push({ type: "text", value: value.slice(last) });
      return out;
    };

    walk(tree);
  };
}
