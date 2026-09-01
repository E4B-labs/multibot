import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// multibot: jedna pigułka zdarzenia w transkrypcie — wąska, jednoliniowa, z
// opcjonalną ikoną i opcjonalnym niebieskim akcentem. Wszystkie zdarzenia
// (utworzenie rutyny, zmiana nazwy, wybór z pickera `/`, start rutyny) idą
// przez nią, żeby nie rozjechały się cztery warianty tego samego elementu.
// Kolejność: przygaszona etykieta, ikona, wyróżniona wartość.
export function EventChip({
  icon,
  label,
  value,
  accent,
  onClick,
  title,
}: {
  icon?: ReactNode;
  /** przygaszony tekst wiodący, np. "Created routine" */
  label?: string;
  /** wyróżniony tekst, np. nazwa rutyny */
  value?: string;
  /** wariant niebieski (--color-accent) — wiąże pigułkę z listą rutyn */
  accent?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  // Zdarzenie nie należy do żadnej ze stron rozmowy, więc idzie środkiem. Bez
  // obwódki i bez tła — ramka i szary prostokąt robiły z tego kolejny kafelek,
  // a to ma być cichy wtręt między wiadomościami (decyzja Kacpra 21.08).
  const content = (
    <>
      {label && <span>{label}</span>}
      {icon}
      {value && <span className={cn("max-w-[320px] truncate font-medium", !accent && "text-ink")}>{value}</span>}
    </>
  );
  const chipClassName = cn(
    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors",
    accent ? "text-accent" : "text-ink-secondary",
    onClick && (accent ? "cursor-pointer hover:text-accent-text" : "cursor-pointer hover:text-ink"),
  );

  return (
    <div className="flex justify-center">
      {onClick ? <button type="button" onClick={onClick} className={chipClassName} title={title}>{content}</button> : <div className={chipClassName}>{content}</div>}
    </div>
  );
}
