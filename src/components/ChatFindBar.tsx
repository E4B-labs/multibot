import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { findMessageHits } from "@/lib/findInChat";
import type { Message } from "@/state/store";
import { useLanguage } from "@/lib/language";

/** multibot: pasek szukania w transkrypcie bota. Enter/Shift+Enter skacze po
 * trafieniach, Escape zamyka. Trafienia liczy findInChat.ts (client-side). */
export function ChatFindBar({
  messages,
  onClose,
  onJump,
}: {
  messages: Message[];
  onClose: () => void;
  onJump: (messageId: string) => void;
}) {
  const polish = useLanguage() === "pl";
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // debounce 150 ms — pisanie nie powinno przeliczać trafień co klawisz
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(raw), 150);
  }, [raw]);

  const hits = useMemo(() => findMessageHits(messages, query), [messages, query]);
  const firstHit = hits[0];
  useEffect(() => setIdx(0), [firstHit]);

  const move = (delta: number) => {
    if (!hits.length) return;
    setIdx((current) => (current + delta + hits.length) % hits.length);
  };

  useEffect(() => {
    if (hits[idx]) onJump(hits[idx]);
  }, [idx, hits, onJump]);

  return (
    <div
      className="absolute right-4 top-2 z-30 flex items-center gap-1 rounded-xl border border-hairline/40 bg-raised px-2 py-1.5 shadow-lg"
      role="search"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            move(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder={polish ? "Szukaj w rozmowie…" : "Find in chat…"}
        className="w-52 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
      />
      <span className="min-w-10 text-center text-[11.5px] tabular-nums text-ink-secondary">
        {hits.length ? `${Math.min(idx + 1, hits.length)}/${hits.length}` : "0/0"}
      </span>
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={!hits.length}
        aria-label={polish ? "Poprzednie trafienie" : "Previous match"}
        className="rounded-md p-1 text-ink-secondary hover:bg-panel hover:text-ink disabled:opacity-40"
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        disabled={!hits.length}
        aria-label={polish ? "Następne trafienie" : "Next match"}
        className="rounded-md p-1 text-ink-secondary hover:bg-panel hover:text-ink disabled:opacity-40"
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={polish ? "Zamknij wyszukiwanie" : "Close search"}
        className="rounded-md p-1 text-ink-secondary hover:bg-panel hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}
