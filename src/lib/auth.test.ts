import { describe, expect, it } from "vitest";

import { authenticatedEventSource } from "./auth";

describe("authenticatedEventSource", () => {
  it("ponawia po nieudanej próbie i dostarcza wiadomość, gdy serwer wraca", async () => {
    const realFetch = global.fetch;
    const calls: number[] = [];
    let attempt = 0;
    global.fetch = (async () => {
      calls.push(++attempt);
      if (attempt === 1) {
        // chwilowy błąd serwera (np. 503 w trakcie restartu)
        return new Response(null, { status: 503, statusText: "Service Unavailable" });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const received: string[] = [];
    const es = authenticatedEventSource("/api/events");
    const done = new Promise<void>((resolve) => {
      es.onmessage = (ev) => {
        received.push(ev.data);
        resolve();
      };
    });

    try {
      await done;
      // pierwsza próba padła (503) — klient musiał wykonać drugie zapytanie,
      // zanim dotarła wiadomość
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(received[0]).toBe("hello");
    } finally {
      es.close();
      global.fetch = realFetch;
    }
  });
});
