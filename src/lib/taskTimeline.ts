// multibot: honest execution timeline — pure projection over the persisted
// transcript (port z OpenMausBot #474-era, src/lib/taskTimeline.ts).
// Never guesses; only renders what the harness recorded.

export interface TimelineMessage {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "event" | "room" | "connector" | "secret";
  text?: string;
  tool?: { name: string; ok?: boolean };
  png?: string;
  at: number;
}

export interface TimelineEvent {
  id: string;
  at: number;
  label: string;
  state: "running" | "complete" | "failed" | "observed";
  kind: "task" | "tool" | "screen" | "result";
}

/** Turn an already-persisted transcript into a compact, honest timeline. */
export function timelineEvents(messages: TimelineMessage[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let sawUserInput = false;
  for (const message of messages) {
    if (message.kind === "text" && message.role === "user" && message.text?.trim()) {
      events.push({
        id: message.id,
        at: message.at,
        label: sawUserInput ? "User input" : "Task started",
        state: "observed",
        kind: "task",
      });
      sawUserInput = true;
    } else if (message.kind === "activity" && message.tool) {
      const failed = message.tool.ok === false || message.tool.name.startsWith("error:");
      events.push({
        id: message.id,
        at: message.at,
        label: failed ? message.tool.name.replace(/^error:\s*/i, "") : message.tool.name,
        state: failed ? "failed" : message.tool.ok === true ? "complete" : "running",
        kind: "tool",
      });
    } else if (message.kind === "screen") {
      events.push({ id: message.id, at: message.at, label: "Screen observed", state: "observed", kind: "screen" });
    } else if (message.kind === "text" && message.role === "bot" && message.text?.trim()) {
      events.push({ id: message.id, at: message.at, label: "Response recorded", state: "complete", kind: "result" });
    }
  }
  return events;
}
