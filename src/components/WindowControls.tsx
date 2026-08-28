// multibot: minimalizuj / maksymalizuj / zamknij rysowane przez interfejs,
// bo na Windowsie i Linuksie okno nie ma ramki systemowej. Kotwica jest
// stała (fixed, prawy górny róg), a nie w nagłówku czatu — nagłówek znika
// przy ustawieniach aplikacji, pokoju grupowym i pustym stanie, a okna musi
// dać się zamknąć zawsze. Stąd też z-index ponad wszystkim, łącznie
// z podglądem załącznika (z-[80]).
import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { hasCustomWindowControls, noDragRegion } from "@/lib/shell";

export function WindowControls() {
  const polish = useLanguage() === "pl";
  if (!hasCustomWindowControls()) return null;

  const button = "rounded-md p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink";

  // 72 px to wysokość nagłówka czatu (py-3 + 48 px przycisku z awatarem) —
  // kontrolki mają stać w jednej linii z jego przyciskami, nie nad nimi.
  return (
    <div
      className="fixed right-0 top-0 z-[90] flex h-[72px] select-none items-center gap-0.5 pr-3"
      style={noDragRegion}
    >
      <button
        onClick={() => window.ogb?.window?.minimize()}
        className={button}
        title={polish ? "Minimalizuj" : "Minimize"}
        aria-label={polish ? "Minimalizuj" : "Minimize"}
      >
        <Minus size={18} />
      </button>
      <button
        onClick={() => window.ogb?.window?.toggleMaximize()}
        className={button}
        title={polish ? "Maksymalizuj lub przywróć" : "Maximize or restore"}
        aria-label={polish ? "Maksymalizuj lub przywróć" : "Maximize or restore"}
      >
        <Square size={15} />
      </button>
      <button
        onClick={() => window.ogb?.window?.close()}
        className={cn(button, "hover:bg-danger hover:text-danger-ink")}
        title={polish ? "Zamknij" : "Close"}
        aria-label={polish ? "Zamknij" : "Close"}
      >
        <X size={18} />
      </button>
    </div>
  );
}
