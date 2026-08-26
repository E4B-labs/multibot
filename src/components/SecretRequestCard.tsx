import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import type { Message } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

export function SecretRequestCard({ botId, message }: { botId: string; message: Message }) {
  const polish = useLanguage() === "pl";
  const card = message.secret;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!card) return null;
  const settled = card.provided || card.dismissed;
  const send = async (dismissed: boolean) => {
    if (busy || (!dismissed && !value.trim())) return;
    setBusy(true);
    setError(null);
    const body = dismissed ? { requestKey: card.requestKey, dismissed: true } : { requestKey: card.requestKey, value };
    try {
      const response = await authFetch(`/api/bots/${botId}/credential`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `${response.status}`);
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[440px] rounded-2xl border border-accent/30 bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><KeyRound size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-ink">{polish ? `Podaj ${card.label}` : `Provide ${card.label}`}</div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{card.description}</div>
          </div>
        </div>
        {settled ? (
          <div className="mt-3 text-[13px] text-success">{card.provided ? polish ? "Zapisano bezpiecznie." : "Saved securely." : polish ? "Pominięto." : "Skipped."}</div>
        ) : (
          <>
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={card.placeholder} autoComplete="off" className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent" aria-label={card.label} />
            {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-3 flex items-center gap-2">
              <button type="button" disabled={busy || !value.trim()} onClick={() => void send(false)} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : polish ? "Zapisz" : "Save"}</button>
              <button type="button" disabled={busy} onClick={() => void send(true)} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:text-ink">{polish ? "Pomiń" : "Skip"}</button>
              {card.helpUrl && <a href={card.helpUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-secondary hover:text-ink">Help <ExternalLink size={12} /></a>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
