// Read-only view of an ephemeral bot-to-bot collaboration room. Opened by
// clicking the "X texted Y" chip in a conversation; the user watches the bots
// work on the task together but cannot post. Live updates ride the SSE "room"
// frames into store.roomOpen.
import { useEffect, useState, Fragment } from "react";
import { ArrowLeftRight, Eye, Loader2, Users, X } from "lucide-react";
import { useStore, formatTime, type Room } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

export function RoomPanel() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const room = state.roomOpen;
  const [gone, setGone] = useState(false);

  // Refresh the transcript once on mount in case the chip's snapshot is stale.
  useEffect(() => {
    if (!room) return;
    let alive = true;
    api(`/api/rooms/${encodeURIComponent(room.id)}`)
      .then((full: Room) => alive && dispatch({ type: "toggleRoom", room: full }))
      .catch(() => alive && setGone(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  if (!room) return null;
  const members = room.bot_ids
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  const nameOf = (botId: string) =>
    state.bots.find((b) => b.id === botId)?.name ?? (polish ? "usunięty bot" : "deleted bot");
  // multibot: klikalna pigułka nazwy — otwiera czat tego bota, jak na screenie
  // "Klaus Chief" / "Klaus -> Motion". Zamyka pokój i selectuje bota.
  const openBot = (botId: string) => {
    if (!state.bots.some((b) => b.id === botId)) return;
    dispatch({ type: "toggleRoom", room: null });
    dispatch({ type: "select", id: botId });
  };
  const statusLabel =
    room.status === "running"
      ? polish ? "pracują…" : "working…"
      : room.status === "done"
        ? polish ? "zakończone" : "done"
        : polish ? "przerwane" : "failed";

  return (
    <main className="animate-panel-in flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="flex items-center px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {members.length > 0 ? (
            // multibot 0.1.44: nagłówek "[avatar] Klaus ⇄ [avatar] Motion" —
            // awatar + nazwa każdego bota, strzałka między nimi; pokój z botem,
            // który zniknął, pokazuje tylko żywych zamiast surowego UUID.
            <div className="flex min-w-0 items-center gap-2">
              {members.slice(0, 2).map((bot, i) => (
                <Fragment key={bot.id}>
                  {i > 0 && <ArrowLeftRight size={14} className="shrink-0 text-ink-secondary" />}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <MausAvatar color={bot.color} shape={bot.mascotShape} state={stateForBot(bot)} size={24} animated={false} />
                    <span className="truncate text-[15px] font-semibold text-ink">{bot.name}</span>
                  </span>
                </Fragment>
              ))}
              {members.length > 2 && (
                <span className="shrink-0 text-[12px] text-ink-secondary">+{members.length - 2}</span>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
                <Users size={16} />
              </span>
              <div className="truncate text-[15px] font-semibold text-ink">
                {room.name || (polish ? "Pokój współpracy" : "Collaboration")}
              </div>
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-[11px] text-ink-secondary">
              {members.length > 0 && `${room.bot_ids.map(nameOf).join(" · ")} · `}{statusLabel}
            </div>
          </div>
        </div>
        <button
          onClick={() => dispatch({ type: "toggleRoom", room: null })}
          className="ml-auto rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label={polish ? "Zamknij pokój" : "Close room"}
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-3">
        {gone ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <Users size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Pokój już nie istnieje" : "This room no longer exists"}</div>
            <span className="text-[12px]">
              {polish ? "Chwilowe pokoje znikają po dłuższej bezczynności." : "Temporary rooms disappear after a long idle."}
            </span>
          </div>
        ) : room.transcript.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <Users size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Boty zaczynają…" : "The bots are starting…"}</div>
            {room.status === "running" && <Loader2 size={14} className="animate-spin" />}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {room.transcript.map((entry) => {
              const entryBot = members.find((b) => b.id === entry.from);
              return (
                <div key={entry.id} className="flex justify-start gap-2.5">
                  <div className="min-w-0 max-w-[85%]">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => openBot(entry.from)}
                        className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised/60 py-0.5 pl-0.5 pr-2 hover:bg-raised"
                        title={polish ? `Otwórz czat ${nameOf(entry.from)}` : `Open ${nameOf(entry.from)}'s chat`}
                      >
                        {entryBot && (
                          <MausAvatar color={entryBot.color} shape={entryBot.mascotShape} state={stateForBot(entryBot)} size={28} animated={false} />
                        )}
                        <span className="text-[12.5px] font-semibold text-accent">{nameOf(entry.from)}</span>
                      </button>
                      <span className="text-[11px] text-ink-secondary">{formatTime(entry.at)}</span>
                    </div>
                    <div className="rounded-2xl rounded-tl-md bg-card px-3.5 py-2 text-[14px] leading-relaxed text-ink">
                      <ChatMarkdown text={entry.text} />
                    </div>
                  </div>
                </div>
              );
            })}
            {room.status === "running" && (
              <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Loader2 size={12} className="animate-spin" />
                {polish ? "Boty pracują…" : "The bots are working…"}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Read-only: no composer — the user watches the bots work. */}
      <div className="border-t border-hairline/40 px-4 py-3">
        <div className="flex items-center justify-center gap-2 text-[12px] text-ink-secondary">
          <Eye size={14} />
          {polish ? "Tylko do odczytu — boty pracują nad zadaniem." : "Read-only — the bots are working on the task."}
        </div>
      </div>
    </main>
  );
}
