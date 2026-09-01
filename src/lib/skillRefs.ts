// skillRefs: nazwa skilla w tekście bota renderuje się jako żółta pigułka
// (jak SkillPill "Grill Me"). Wtyczka remark rozbija węzły tekstowe na
// segmenty; nazwy bieżącego bota ładuje ChatView, więc działają przed
// pierwszym otwarciem panelu skilli. Kliknięcie otwiera panel skilli.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function remarkSkillRefs({ skills }: { skills: string[] }) {
  const unique = [...new Set(skills.map((name) => name.trim()).filter(Boolean))];
  if (!unique.length) return () => {};
  // dłuższe nazwy najpierw, żeby "Grill Me Pro" złapać przed "Grill Me"
  const names = unique.sort((a, b) => b.length - a.length).map(escapeRe);
  // Prefix is captured instead of lookbehind. Unicode boundary supports
  // Polish names and skills ending in punctuation, for example "C++".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${names.join("|")})(?=$|[^\\p{L}\\p{N}_])`, "giu");
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child.type === "text") {
          const parts: any[] = [];
          let last = 0;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(child.value))) {
            const at = m.index + m[1].length;
            const label = m[2];
            if (at > last) parts.push({ type: "text", value: child.value.slice(last, at) });
            parts.push({
              type: "skillRef",
              data: { hName: "span", hProperties: { dataSkillRef: label } },
              children: [{ type: "text", value: label }] as any,
            });
            last = at + label.length;
          }
          if (parts.length) {
            if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
            node.children.splice(i, 1, ...parts);
          }
        } else if (child.type !== "code" && child.type !== "inlineCode") {
          walk(child);
        }
      }
    };
    walk(tree);
  };
}

/** Lista wtyczek do składowania w ChatMarkdown. */
export function withSkillRefPlugins(plugins: unknown[], skills: string[]): unknown[] {
  return skills.length ? [...plugins, [remarkSkillRefs, { skills }]] : plugins;
}
