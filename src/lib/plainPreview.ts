// multibot: podgląd wiadomości w pasku bocznym to jedna linia zwykłego tekstu,
// nie markdown. Bot pisze `## Raport` i `**Pies**`, a na liście widać było
// surowe znaczniki zamiast treści. Renderowanie markdownu w jednej linijce nic
// by nie dało (pogrubienie w podglądzie niczego nie porządkuje), więc
// znaczniki po prostu zdejmujemy i zostaje sam tekst.

/** Markdown sprowadzony do jednej linii zwykłego tekstu. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // bloki kodu: w podglądzie bezużyteczne
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // linki i obrazki: zostaje etykieta
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "")
    // ponytail: tylko gwiazdki. Podkreślnik jako wyróżnienie prawie nie pada
    // w tekście botów, a zjadłby `plik_z_podkreslnikami` i `__init__.py`.
    // Gdyby kiedyś było potrzebne — trzeba dołożyć strażnika granicy słowa.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(?=\S)(.*?)(?<=\S)\*/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ") // wieloliniowa odpowiedź ma zmieścić się w jednym wierszu
    .trim();
}
