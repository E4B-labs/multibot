import { SHAPE, type CursorShape } from "@/components/CursorAvatar";

/**
 * Kształty maskotki oferowane w wyborze, w kolejności pokazu.
 *
 * Wzór: zestaw brył od Kacpra (soczewka, kursor, koło, kwadrat, pigułka,
 * trójkąt, gwiazda, romb, teczka). Z obrazka wzięte są SAME KSZTAŁTY —
 * obwódki i połysk zostają tam, bo tutaj obowiązuje płaska sylwetka
 * z gradientem instancji.
 */
export const MASCOT_SHAPES = [
  "blob",
  "leaf",
  "cursor",
  "circle",
  "square",
  "pill",
  "triangle",
  "star",
  "diamond",
  "folder",
] as const;

/**
 * Kształty wycofane z wyboru, ale nadal rysowane.
 *
 * Boty trzymają swój kształt w `BotRecord.mascotShape` (`server/store.ts`).
 * Skasowanie definicji sprawiłoby, że bot z zapisanym `cloud` cicho zmienia
 * się w kursor — czyli użytkownik traci wygląd, którego nie ruszał. Nowych
 * botów już się w te kształty nie ubiera, stare zostają takie, jakie są.
 */
const LEGACY_SHAPES = ["oval", "hexagon", "cloud", "drop"] as const;

export type MascotShape = (typeof MASCOT_SHAPES)[number] | (typeof LEGACY_SHAPES)[number];

const BOX = 114.2705;

const simple = (name: Exclude<MascotShape, "cursor">, body: string): CursorShape => ({
  name,
  fit: "",
  body,
  clip: body.replace(/ fill="\{\{GRADIENT\}\}"/g, ""),
  anchor: { x: BOX, y: BOX, scale: 0.86 },
});

const BLOB_BODY = '<path xmlns="http://www.w3.org/2000/svg" fill="{{GRADIENT}}" d="M175.67 108.19Q175.61 116.39 172.02 124.18Q168.43 131.97 161.78 138.28Q155.12 144.60 146.59 148.97Q138.07 153.35 128.74 155.97Q119.40 158.60 109.70 159.75Q100.00 160.91 90.06 160.47Q80.13 160.02 70.49 157.45Q60.85 154.88 52.66 149.91Q44.48 144.93 38.95 138.01Q33.43 131.10 30.99 123.29Q28.55 115.49 28.58 107.75Q28.60 100.00 30.14 92.59Q31.67 85.18 34.36 77.89Q37.04 70.59 41.46 63.40Q45.88 56.21 52.83 49.91Q59.77 43.62 69.21 39.57Q78.65 35.52 89.33 34.75Q100.00 33.97 110.12 36.42Q120.24 38.88 128.62 43.52Q136.99 48.15 143.59 53.77Q150.20 59.38 155.64 65.42Q161.09 71.46 165.59 78.13Q170.09 84.80 172.91 92.40Q175.72 100.00 175.67 108.19Z"/>';

// Zaokrąglenia siedzą w geometrii ścieżki, nie w obrysie. `clip` to clipPath,
// a clipPath liczy wyłącznie wypełnienie — obrys z `stroke-linejoin="round"`
// dałby zaokrągloną sylwetkę i ostry obszar przycięcia, więc twarz maskotki
// ucinałaby się w rogach inaczej, niż widać kształt.
const SHAPES: Record<Exclude<MascotShape, "cursor">, CursorShape> = {
  blob: {
    name: "blob",
    fit: "translate(-44.4052 -37.3374) scale(1.553736)",
    body: BLOB_BODY,
    clip: BLOB_BODY.replace(/ fill="\{\{GRADIENT\}\}"/, ""),
    anchor: { x: 116, y: 108, scale: 1.09 },
  },
  // Soczewka: dwa łuki o tym samym promieniu, oba wybrzuszone na zewnątrz.
  // Promień steruje grubością i jest odwrotny do intuicji — im MNIEJSZY, tym
  // soczewka pełniejsza. Nie może zejść poniżej połowy cięciwy (127), bo wtedy
  // łuk nie ma jak połączyć końców.
  leaf: simple("leaf", '<path d="M24 204A150 150 0 0 1 204 24A150 150 0 0 1 24 204Z" fill="{{GRADIENT}}"/>'),
  circle: simple("circle", '<circle cx="114.2705" cy="114.2705" r="96" fill="{{GRADIENT}}"/>'),
  square: simple("square", '<rect x="24" y="24" width="180" height="180" rx="38" fill="{{GRADIENT}}"/>'),
  pill: simple("pill", '<rect x="12" y="64" width="204" height="100" rx="50" fill="{{GRADIENT}}"/>'),
  // Trójkąt wskazujący w prawo. Każdy róg to krzywa kwadratowa, której punktem
  // sterującym jest sam wierzchołek — stąd zaokrąglenie bez obrysu.
  triangle: simple(
    "triangle",
    '<path d="M80 40.3 179.9 99.9Q204 114.3 179.9 128.6L80 188.2Q56 202.5 56 174.5L56 54Q56 26 80 40.3Z" fill="{{GRADIENT}}"/>',
  ),
  star: simple(
    "star",
    '<path d="M114.3 14.3 140.7 77.9 209.4 83.4 157.1 128.2 173.1 195.2 114.3 159.3 55.5 195.2 71.5 128.2 19.2 83.4 87.8 77.9Z" fill="{{GRADIENT}}"/>',
  ),
  // Romb to ten sam zaokrąglony kwadrat obrócony o 45 stopni. Osobna ścieżka
  // powtarzałaby te same łuki, tylko trudniej je było policzyć.
  diamond: simple(
    "diamond",
    '<rect x="41" y="41" width="146" height="146" rx="28" transform="rotate(45 114.2705 114.2705)" fill="{{GRADIENT}}"/>',
  ),
  folder: simple(
    "folder",
    '<path d="M26 76Q26 54 48 54L92 54Q102 54 108 62L118 74 180 74Q202 74 202 96L202 176Q202 198 180 198L48 198Q26 198 26 176Z" fill="{{GRADIENT}}"/>',
  ),

  // Wycofane z wyboru, patrz LEGACY_SHAPES.
  oval: simple("oval", '<ellipse cx="114.2705" cy="114.2705" rx="103" ry="82" fill="{{GRADIENT}}"/>'),
  hexagon: simple("hexagon", '<path d="m57 20 114 0 57 94-57 94H57L0 114Z" transform="translate(0 0)" fill="{{GRADIENT}}"/>'),
  cloud: simple("cloud", '<path d="M48 190h126c30 0 45-19 45-40 0-23-18-40-42-40-8-32-31-51-63-51-34 0-60 23-66 56-26 0-45 17-45 39 0 21 18 36 45 36Z" transform="translate(0 -2)" fill="{{GRADIENT}}"/>'),
  drop: simple("drop", '<path d="M114 12C94 44 45 83 45 133c0 43 30 70 69 70s69-27 69-70c0-50-49-89-69-121Z" fill="{{GRADIENT}}"/>'),
};

export function mascotShape(value: string | null | undefined): CursorShape {
  return value && value !== "cursor" && value in SHAPES
    ? SHAPES[value as Exclude<MascotShape, "cursor">]
    : SHAPE;
}
