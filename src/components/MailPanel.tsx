// Durable agent-to-agent mailbox. User can inspect every 1:1 exchange without
// opening either bot's private main chat.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Inbox, Loader2, Mail, X } from "lucide-react";

import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";
import { formatTime, useStore, type Bot, type MailThread } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";

async function fetchThread(id: string): Promise<MailThread> {
  const response = await authFetch(`/api/mail/${encodeURIComponent(id)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body as MailThread;
}

function botName(bots: Bot[], id: string, polish: boolean): string {
  return bots.find((bot) => bot.id === id)?.name ?? (polish ? "usunięty bot" : "deleted bot");
}

export function MailPanel() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const threads = useMemo(
    () => state.mailThreads.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [state.mailThreads],
  );
  const [selectedId, setSelectedId] = useState(threads[0]?.id ?? "");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!threads.some((thread) => thread.id === selectedId)) setSelectedId(threads[0]?.id ?? "");
  }, [threads, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    setLoading(true);
    fetchThread(selectedId)
      .then((thread) => alive && dispatch({ type: "mailUpsert", thread }))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [dispatch, selectedId]);

  const thread = threads.find((item) => item.id === selectedId) ?? null;
  const close = () => dispatch({ type: "toggleMail", open: false });

  return (
    <main className="animate-panel-in flex h-full min-w-0 flex-1 flex-col bg-app text-ink">
      <header className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
        <button
          onClick={close}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label={polish ? "Wróć do czatu" : "Back to chat"}
        >
          <ArrowLeft size={18} />
        </button>
        <Mail size={18} className="text-accent" />
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold">{polish ? "Mail agentów" : "Agent mail"}</h1>
          <p className="text-[11px] text-ink-secondary">
            {polish ? "Trwałe wiadomości botów między sobą" : "Durable bot-to-bot messages"}
          </p>
        </div>
        <button onClick={close} className="ml-auto rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={polish ? "Zamknij" : "Close"}>
          <X size={18} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-hairline/40 p-2 max-md:w-[42%]">
          {threads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-12 text-center text-[12px] text-ink-secondary">
              <Inbox size={22} />
              {polish ? "Brak maili agentów" : "No agent mail yet"}
            </div>
          ) : threads.map((item) => {
            const last = item.messages.at(-1);
            return (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "mb-1 w-full rounded-lg px-2.5 py-2 text-left hover:bg-raised/70",
                  item.id === selectedId && "bg-raised",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12.5px] font-medium">
                    {item.bot_ids.map((id) => botName(state.bots, id, polish)).join(" · ")}
                  </span>
                  {last && <span className="shrink-0 text-[10px] text-ink-secondary">{formatTime(last.at)}</span>}
                </div>
                <div className="mt-1 truncate text-[11px] text-ink-secondary">{last?.text ?? ""}</div>
              </button>
            );
          })}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {!thread ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-ink-secondary">
              <Inbox size={26} />
              <span className="text-[13px]">{polish ? "Boty nie wymieniły jeszcze maili" : "Bots have not exchanged mail yet"}</span>
            </div>
          ) : (
            <>
              <div className="border-b border-hairline/40 px-5 py-3">
                <div className="truncate text-[14px] font-semibold">
                  {thread.bot_ids.map((id) => botName(state.bots, id, polish)).join("  ↔  ")}
                </div>
                <div className="text-[11px] text-ink-secondary">
                  {thread.messages.length} {polish ? "wiadomości" : "messages"}
                </div>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
                {thread.messages.map((message) => {
                  const sender = state.bots.find((bot) => bot.id === message.from);
                  return (
                    <article key={message.id} className="flex gap-2.5">
                      {sender ? (
                        <MausAvatar color={sender.color} avatarUrl={sender.avatarUrl} shape={sender.mascotShape} state={stateForBot(sender)} size={28} animated={false} />
                      ) : <span className="size-7 shrink-0 rounded-full bg-raised" />}
                      <div className="min-w-0 max-w-[80%]">
                        <div className="mb-1 flex flex-wrap items-baseline gap-2">
                          <span className="text-[12px] font-semibold">{botName(state.bots, message.from, polish)}</span>
                          <span className="text-[10px] text-ink-secondary">{formatTime(message.at)}</span>
                          {message.status === "queued" && <span className="text-[10px] text-accent">{polish ? "oczekuje" : "queued"}</span>}
                          {message.status === "failed" && <span className="text-[10px] text-danger">{polish ? "błąd" : "failed"}</span>}
                        </div>
                        <div className="rounded-2xl rounded-tl-md bg-card px-3.5 py-2 text-[13px] leading-relaxed">
                          <ChatMarkdown text={message.text} />
                        </div>
                      </div>
                    </article>
                  );
                })}
                {loading && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
              </div>
              <div className="border-t border-hairline/40 px-5 py-3 text-[11px] text-ink-secondary">
                {polish ? "Mail agentów działa asynchronicznie. Odpowiedź budzi adresata w nowej turze." : "Agent mail is asynchronous. A reply wakes its recipient in a fresh turn."}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
