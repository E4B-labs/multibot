// multibot (2.4): wzmianki `@imię bota` renderują się jako chip z awatarem,
// nie surowy tekst. Wtyczka remark rozbija węzły tekstowe markdowna na
// segmenty; imiona przychodzą ze store'a, więc komponent nie potrzebuje
// nowych propsów, a bloki kodu zostają nietknięte (remark ich nie rusza).
//
// Osobny plik, bo to czysta logika bez Reacta — dzięki temu ma test, który
// odpala się w środowisku node razem z resztą pakietu.

/** Wystarczy imię; store podaje pełnego bota, struktura pasuje. */
export type MentionBot = { name: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * unified woła atacher SAM — `use(fn, opcje)` albo krotka `[fn, opcje]` na
 * liście wtyczek. Wywołanie `remarkMentions({ bots })` bezpośrednio W LIŚCIE
 * oddawało unifiedowi gotowy transformer, który unified brał za atacher i
 * odpalał BEZ drzewa: `walk(undefined)` rzucało „Cannot read properties of
 * undefined (reading 'children')", `#root` zostawał pusty i aplikacja
 * pokazywała czarny ekran na telefonie i na desktopie. Stąd `mentionPlugins`
 * niżej oddaje krotkę i stąd test, który tę pomyłkę odtwarza.
 */
export function remarkMentions({ bots }: { bots: MentionBot[] }) {
  const names = bots.map((b) => b.name).sort((a, b) => b.length - a.length).map(escapeRe);
  // Bez lookbehind (`(?<!…)`): starsze WebView Androida (przed Chrome 62)
  // rzucają na nim SyntaxError przy wczytaniu paczki, co też kończy się
  // czarnym ekranem. Grupa 1 to znak przed „@" — wraca do tekstu, więc
  // adresy pocztowe (`ktos@example.com`) zostają w całości.
  const re = new RegExp(`(^|[^\\w.@-])@(${names.join("|")})(?![\\w-])`, "gi");
  return (tree: any) => {
    const split = (node: any): any[] => {
      const out: any[] = [];
      let last = 0;
      re.lastIndex = 0;
      for (let m = re.exec(node.value); m; m = re.exec(node.value)) {
        const at = m.index + m[1].length;
        const label = `@${m[2]}`;
        if (at > last) out.push({ type: "text", value: node.value.slice(last, at) });
        out.push({
          type: "mention",
          data: { hName: "span", hProperties: { dataMention: m[2] } },
          children: [{ type: "text", value: label }],
        });
        last = at + label.length;
      }
      if (!out.length) return [node];
      if (last < node.value.length) out.push({ type: "text", value: node.value.slice(last) });
      return out;
    };
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child.type === "text") node.children.splice(i, 1, ...split(child));
        else walk(child);
      }
    };
    walk(tree);
  };
}

/**
 * Lista wtyczek remark dla wiadomości czatu. `gfm` zawsze; wzmianki dopiero
 * gdy są jakieś imiona — pusta alternatywa w regexie łapałaby każde „@".
 */
export function mentionPlugins(gfm: unknown, bots: MentionBot[]): unknown[] {
  return bots.length ? [gfm, [remarkMentions, { bots }]] : [gfm];
}
