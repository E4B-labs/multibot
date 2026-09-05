// multibot: F9-FE — pokój grupowy jako pełny panel rozmowy, taki sam slot jak
// zwykły agent. UI gada wyłącznie z przelotką harnessu
// (`server/engine/proxy.ts`: `/api/engine/<rest>` → `/api/<rest>` silnika):
//   POST /api/engine/groups/<gid>/tasks {tasks: [{bot_id, message}]} →
//     {tasks: [{bot_id, message, reply}]} (engine/server/app.py + groups.py).
//
// ŹRÓDŁO HISTORII (decyzja): zadania idą zwykłym `gateway.chat` bez markera
// grupy, więc odpowiedzi bota zapisują się także w jego czacie 1:1. Panel
// trzyma wspólny zapis zadań i odpowiedzi w tej sesji aplikacji.
// ponytail: transkrypt w module-level Map (życie = sesja apki, przeżywa
// zamknięcie/otwarcie panelu); upgrade = transkrypt grupy po stronie silnika,
// gdy pokój ma pamiętać po restarcie apki.
import { useEffect, useState } from "react";
import { Loader2, Monitor, Send, Users } from "lucide-react";
import { useStore, formatTime, type EngineGroup } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";

// Ten sam lokalny helper co RoutinesPanel: silnik zwraca błędy jako `{detail}`
// (FastAPI), przelotka jako `{error}`.
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    throw new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

/** `from`: "you" albo id bota silnika (`mb-<threadId>`). */
interface Entry {
  from: "you" | string;
  text: string;
  at: number;
}

export function buildGroupTasks(botIds: string[], values: Record<string, string>) {
  return botIds.flatMap((bot_id) => {
    const message = (values[bot_id] ?? "").trim();
    return message ? [{ bot_id, message }] : [];
  });
}

const transcripts = new Map<string, Entry[]>();

export function GroupPanel({ group }: { group: EngineGroup }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [entries, setEntries] = useState<Entry[]>(() => group.messages ?? transcripts.get(group.id) ?? []);
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api(`/api/groups/${group.id}`)
      .then((saved: { messages?: Entry[] }) => alive && setEntries(saved.messages ?? []))
      .catch(() => {});
    return () => { alive = false; };
  }, [group.id]);

  // Ten sam wzorzec id co EngineUsage/RoutinesPanel: `mb-<threadId>` z
  // decodeConfig w server/drivers/slafy.ts — odwracalny, więc nazwa bota apki
  // wychodzi z samego id; obcy id zostaje jak jest.
  const nameOf = (engineBotId: string) => {
    if (engineBotId === "you") return polish ? "Ty" : "You";
    const direct = state.bots.find((b) => b.id === engineBotId);
    if (direct) return botDisplayName(direct, polish ? "pl" : "en");
    const threadId = engineBotId.startsWith("mb-") ? engineBotId.slice(3) : engineBotId;
    const byThread = state.bots.find((b) => b.threadId === threadId);
    return byThread ? botDisplayName(byThread, polish ? "pl" : "en") : engineBotId;
  };
  const memberRows = group.bot_ids
    .map((engineBotId) => {
      const threadId = engineBotId.startsWith("mb-") ? engineBotId.slice(3) : engineBotId;
      return {
        engineBotId,
        bot: state.bots.find((b) => b.threadId === threadId || b.id === engineBotId),
      };
    })
    .filter((row): row is typeof row & { bot: (typeof state.bots)[number] } => Boolean(row.bot));
  const members = memberRows.map((row) => row.bot);

  const push = (added: Entry[]) =>
    setEntries((cur) => {
      const next = [...cur, ...added];
      transcripts.set(group.id, next);
      return next;
    });

  // multibot: odpowiedzi NIE czekamy. Bot dostaje zwykłą turę i odpisuje we
  // własnym czasie, a wymiana leci ramkami SSE `room` do wspólnego pokoju
  // grupy — trzymanie tu `await` na sumę tur wieszało panel na minuty.
  // Rooms accumulate: a finished one keeps its groupId, so `find` would pin
  // the panel to the oldest conversation forever. Newest open room wins.
  const groupRoom = state.rooms
    .filter((room) => room.groupId === group.id && room.status === "running")
    .at(-1);
  const roomEntries: Entry[] = (groupRoom?.transcript ?? []).map(
    (message) => ({ from: message.from, text: message.text, at: message.at }),
  );

  const allEntries = [...entries, ...roomEntries].sort((a, b) => a.at - b.at);

  const runTasks = () => {
    const assignments = buildGroupTasks(group.bot_ids, tasks);
    if (!assignments.length || busy) return;
    setBusy(true);
    setError(null);
    const at = Date.now();
    push(assignments.map((task) => ({ from: "you", text: `${nameOf(task.bot_id)}: ${task.message}`, at })));
    setTasks({});
    api(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ tasks: assignments }),
    })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <main className="animate-panel-in flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header — ten sam rytm co zwykły panel agenta */}
      <div data-shell-header className="flex items-center px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {members.length > 0 ? (
            <div className="flex -space-x-2 shrink-0">
              {members.slice(0, 3).map((bot) => (
                <MausAvatar key={bot.id} color={bot.color} avatarUrl={bot.avatarUrl} shape={bot.mascotShape} state={stateForBot(bot)} size={28} animated={false} />
              ))}
            </div>
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
              <Users size={16} />
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink">{group.name || (polish ? "Grupa" : "Group")}</div>
            <div className="truncate text-[11px] text-ink-secondary">
              {members.length} {polish ? "botów" : "bots"} · {group.bot_ids.map(nameOf).join(" · ")}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            const member = members[0];
            if (member) dispatch({ type: "selectComputer", id: member.id });
            dispatch({ type: "toggleComputer", open: true });
          }}
          className="ml-auto rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
          title={polish ? "Otwórz komputer bota" : "Open bot computer"}
          aria-label={polish ? "Otwórz komputer bota" : "Open bot computer"}
        >
          <Monitor size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-3">
        {allEntries.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <Users size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Brak wiadomości w tej sesji" : "No messages this session"}</div>
            <span className="text-[12px]">
              {polish
                ? "Wpisz osobne zadanie przy każdym bocie. Puste pola zostaną pominięte."
                : "Enter one task per bot. Empty fields are skipped."}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {allEntries.map((e, i) => {
              const entryBot = e.from === "you" ? null : members.find(
                (b) => b.id === e.from || b.threadId === (e.from.startsWith("mb-") ? e.from.slice(3) : e.from),
              ) ?? null;
              return e.from === "you" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-bubble-user px-3.5 py-2 text-[14px] leading-relaxed text-ink">
                    {e.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start gap-2.5">
                  {entryBot && (
                    <MausAvatar color={entryBot.color} avatarUrl={entryBot.avatarUrl} shape={entryBot.mascotShape} state={stateForBot(entryBot)} size={28} animated={false} />
                  )}
                  <div className="min-w-0 max-w-[85%]">
                    <div className="mb-1 flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-semibold text-ink">{nameOf(e.from)}</span>
                      <span className="text-[11px] text-ink-secondary">{formatTime(e.at)}</span>
                    </div>
                    <div className="rounded-2xl bg-card px-3.5 py-2 text-[14px] leading-relaxed text-ink">
                      <ChatMarkdown text={e.text} />
                    </div>
                  </div>
                </div>
              );
            })}
            {busy && (
              <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Loader2 size={12} className="animate-spin" />
                {polish ? "Wysyłam do pokoju…" : "Sending to the room…"}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>

      {/* Jedno zadanie na bota; wszystkie niepuste pola lecą równolegle. */}
      <div className="border-t border-hairline/40 px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-[12px] text-ink-secondary">
          <span>{polish ? "Zadania botów" : "Bot tasks"}</span>
          <span>{buildGroupTasks(group.bot_ids, tasks).length}/{memberRows.length}</span>
        </div>
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {memberRows.map(({ engineBotId, bot }) => (
            <div key={engineBotId} className="flex items-start gap-2">
              <MausAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape={bot.mascotShape} state={stateForBot(bot)} size={24} animated={false} />
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[11px] font-medium text-ink-secondary">{botDisplayName(bot, polish ? "pl" : "en")}</div>
                <textarea
                  className="min-h-12 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                  placeholder={polish ? "Zadanie dla tego bota" : "Task for this bot"}
                  value={tasks[engineBotId] ?? ""}
                  onChange={(e) => setTasks((current) => ({ ...current, [engineBotId]: e.target.value }))}
                  disabled={busy}
                />
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={runTasks}
          disabled={busy || buildGroupTasks(group.bot_ids, tasks).length === 0}
          className={cn(
            "mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={polish ? "Uruchom zadania równolegle" : "Run tasks in parallel"}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {polish ? "Uruchom zadania" : "Run tasks"}
        </button>
      </div>
    </main>
  );
}
