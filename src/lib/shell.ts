// multibot: kto rysuje ramkę okna. Na Windowsie i Linuksie aplikacja leci
// bezramkowo (electron/main.mjs → frame:false), więc minimalizację,
// maksymalizację i zamknięcie musi narysować sam interfejs. Preload wystawia
// `window.ogb.window` dokładnie tam i tylko tam, więc jedno sprawdzenie
// odsiewa naraz przeglądarkę i macOS-a. Platformy NIE zgadujemy z userAgenta:
// decyzja o ramce zapada w main.mjs i to ona ma być jedynym źródłem prawdy.
//
// Resztę — przeciąganie okna za nagłówki i pas zarezerwowany pod kontrolkami —
// robi CSS na klasie `multibot-frameless` i atrybucie `data-shell-header`
// (src/styles.css). Dzięki temu żaden panel nie musi wiedzieć, czy akurat stoi
// przy prawej krawędzi okna.
import type { CSSProperties } from "react";

type WindowControlsHost = { ogb?: { window?: { close?: unknown } } };

export function hasCustomWindowControls(
  host: WindowControlsHost | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  return typeof host?.ogb?.window?.close === "function";
}

/** Kontrolki okna wiszą poza nagłówkami, więc żaden obszar `drag` ich nie
 * obejmuje — ale oznaczamy je wprost, żeby zmiana układu nie zamieniła ich
 * cicho w uchwyt do przeciągania. */
export const noDragRegion = { WebkitAppRegion: "no-drag" } as CSSProperties;
