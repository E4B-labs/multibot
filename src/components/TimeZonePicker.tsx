// multibot: wybór strefy czasowej bota. Lista idzie prosto z przeglądarki
// (`Intl.supportedValuesOf`), więc są w niej wszystkie strefy IANA, a nie
// garść wybranych ręcznie.
//
// Pierwsza pozycja to „Wykryj automatycznie" i zapisuje się jako pusty ciąg —
// dzięki temu po przewiezieniu komputera do innego kraju bot idzie za zegarem,
// zamiast zostać na strefie sprzed przeprowadzki.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  AUTO_TIMEZONE,
  detectTimeZone,
  filterTimeZones,
  listTimeZones,
  zoneLabel,
  zoneTime,
} from "@/lib/timezone";

export function TimeZonePicker({
  value,
  onChange,
  polish,
}: {
  value: string;
  onChange: (zone: string) => void;
  polish: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Zegar odświeżamy co pół minuty, żeby godziny na liście nie kłamały przy
  // dłużej otwartym panelu.
  const [now, setNow] = useState(() => new Date());

  const detected = useMemo(() => detectTimeZone(), []);
  const zones = useMemo(() => listTimeZones(), []);
  const autoLabel = polish
    ? `Wykryj automatycznie (${zoneLabel(detected)})`
    : `Detect automatically (${zoneLabel(detected)})`;

  // Pozycja automatyczna zachowuje się jak każdy inny wiersz — także przy
  // szukaniu, gdzie ma się dać znaleźć po nazwie wykrytej strefy.
  const rows = useMemo(() => {
    const matches = filterTimeZones(zones, query);
    const auto = { id: AUTO_TIMEZONE, label: autoLabel, zone: detected };
    const rest = matches.map((zone) => ({ id: zone, label: zoneLabel(zone), zone }));
    const needle = query.trim().toLowerCase();
    const autoVisible = !needle || autoLabel.toLowerCase().includes(needle) || matches.includes(detected);
    return autoVisible ? [auto, ...rest] : rest;
  }, [zones, query, autoLabel, detected]);

  useEffect(() => setHighlight(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    const clock = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      clearInterval(clock);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setNow(new Date());
    inputRef.current?.focus();
  }, [open]);

  // Wybrana strefa bywa daleko w dole listy — bez tego panel otwierałby się na
  // Afryce, choćby wybrana była Australia.
  useLayoutEffect(() => {
    if (!open) return;
    const index = rows.findIndex((row) => row.id === value);
    if (index < 0) return;
    listRef.current?.children[index]?.scrollIntoView({ block: "center" });
  }, [open]);

  const pick = (zone: string) => {
    onChange(zone);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const next = (highlight + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      setHighlight(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[highlight];
      if (row) pick(row.id);
    }
  };

  const current = value === AUTO_TIMEZONE ? autoLabel : zoneLabel(value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex max-w-[280px] items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink hover:bg-raised/40 focus:outline-none"
      >
        <span className="truncate">{current}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-secondary" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-30 mt-1.5 w-[360px] overflow-hidden rounded-xl border border-hairline/40 bg-card shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={polish ? "Szukaj strefy czasowej" : "Search time zone"}
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={polish ? "Zamknij" : "Close"}
              className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>

          <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
            {rows.length === 0 && (
              <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
                {polish ? "Brak pasującej strefy" : "No matching time zone"}
              </div>
            )}
            {rows.map((row, index) => (
              <button
                key={row.id || "auto"}
                type="button"
                role="option"
                aria-selected={row.id === value}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(row.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] text-ink",
                  index === highlight && "bg-raised",
                )}
              >
                <span className="flex-1 truncate">{row.label}</span>
                <span className="shrink-0 text-ink-secondary">{zoneTime(row.zone, now)}</span>
                <Check
                  size={14}
                  className={cn("shrink-0 text-ink", row.id === value ? "opacity-100" : "opacity-0")}
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
