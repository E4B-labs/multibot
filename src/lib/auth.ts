// G2: one authenticated transport for every browser request.
const TOKEN_KEY = "multibot.auth.token";
const AUTH_REQUIRED = "multibot:auth-required";

export function getAuthToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAuthToken(token: string): void {
  try {
    const value = token.trim();
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage can be disabled in private browsing */
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage can be disabled in private browsing */
  }
}

export function bootstrapLocalAuthToken(): void {
  const token = new URLSearchParams(location.hash.slice(1)).get("access_token");
  if (!token) return;
  setAuthToken(token);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

export function authEventName(): string {
  return AUTH_REQUIRED;
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const token = getAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    window.dispatchEvent(new Event(AUTH_REQUIRED));
  }
  return response;
}

type EventChannel = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close: () => void;
};

/**
 * Kanał zdarzeń aplikacji. WebSocket jest transportem pierwszego wyboru, bo
 * pośrednicy potrafią buforować odpowiedź SSE do końca strumienia — szybki
 * tunel Cloudflare robi dokładnie to i `/api/events` po SSE nie dowozi wtedy
 * ani jednej ramki (dymek wysłanej wiadomości zostaje szary, bo `message`
 * nigdy nie przychodzi). Gdy WS nie wstanie ani razu — zwykle blokada po
 * drodze albo brak WebSocketa w środowisku — schodzimy na SSE i działamy jak
 * dotąd.
 */
export function authenticatedEventSource(path: string): EventChannel {
  const source: EventChannel = {
    onopen: null,
    onerror: null,
    onmessage: null,
    close: () => {},
  };
  if (typeof WebSocket === "undefined" || typeof location === "undefined") {
    return sseEventSource(path, source);
  }

  let stopped = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sse: EventChannel | undefined;
  let retry = 0;

  const fallback = () => {
    sse = sseEventSource(path, source);
  };

  const open = () => {
    if (stopped) return;
    let opened = false;
    try {
      socket = authenticatedWebSocket(path);
    } catch {
      // brak `location`/WebSocketa (np. test w node) — zostaje SSE
      return fallback();
    }
    socket.onopen = () => {
      opened = true;
      retry = 0;
      source.onopen?.();
    };
    socket.onmessage = (event) => {
      source.onmessage?.(new MessageEvent("message", { data: String(event.data) }));
    };
    socket.onclose = () => {
      if (stopped) return;
      source.onerror?.();
      // Nigdy nie zdążył się otworzyć przy pierwszym podejściu — ten transport
      // tu nie przechodzi, więc nie zapętlamy się na nim.
      if (!opened && retry === 0) return fallback();
      retry = Math.min(retry + 1, 5);
      timer = setTimeout(open, retry * 1000);
    };
    socket.onerror = () => {
      /* onclose i tak przyjdzie — tam jest cała obsługa */
    };
  };

  source.close = () => {
    stopped = true;
    clearTimeout(timer);
    sse?.close();
    socket?.close();
  };
  open();
  return source;
}

function sseEventSource(path: string, source: EventChannel): EventChannel {
  let stopped = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pendingWait: ReturnType<typeof setTimeout> | undefined;
  let retry = 0;
  source.close = () => {
    stopped = true;
    clearTimeout(pendingWait);
    void reader?.cancel();
  };
  const wait = () => new Promise<void>((resolve) => {
    pendingWait = setTimeout(resolve, retry * 1000);
  });
  void (async () => {
    while (!stopped) {
      let delivered = false;
      try {
        const response = await authFetch(path, { headers: { accept: "text/event-stream" } });
        if (response.status === 401) {
          // Nieważny token — ponawianie tylko zapętla odpytywanie. Kończymy.
          source.onerror?.();
          return;
        }
        if (!response.ok || !response.body) {
          source.onerror?.();
          retry = Math.min(retry + 1, 5);
          if (stopped) return;
          await wait();
          continue;
        }
        source.onopen?.();
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) {
              delivered = true;
              source.onmessage?.(new MessageEvent("message", { data }));
            }
          }
        }
        if (stopped) return;
        source.onerror?.();
        // Zerujemy backoff dopiero po strumieniu, który realnie coś dostarczył.
        // Serwer, który łączy i natychmiast zrywa, musi wspinać się po odstępach.
        retry = delivered ? 0 : Math.min(retry + 1, 5);
        if (stopped) return;
        await wait();
      } catch {
        // Błąd sieci (np. serwer w trakcie restartu) — ponawiamy, nie giniemy.
        source.onerror?.();
        if (stopped) return;
        retry = Math.min(retry + 1, 5);
        if (stopped) return;
        await wait();
      }
    }
  })();
  return source;
}

export function authenticatedWebSocket(path: string, protocol = location.protocol): WebSocket {
  const token = getAuthToken();
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${wsProtocol}//${location.host}${path}`, token ? ["multibot-auth", token] : undefined);
}

/**
 * multibot (H4): trade the bearer token for a session cookie, once.
 *
 * The bot's screen is an <iframe> of noVNC and its websocket is opened by
 * noVNC itself. Neither can carry an Authorization header or our WS
 * subprotocol, so a cookie is the only credential that reaches them. The
 * exchange itself requires the token, so this does not widen the auth gate.
 */
let sessionPromise: Promise<void> | null = null;

export function ensureBrowserSession(): Promise<void> {
  return (sessionPromise ??= authFetch("/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ label: "browser" }),
  })
    .then(() => undefined)
    .catch(() => {
      // A missing cookie only costs the screen; the rest of the app keeps
      // working on the token. Retry on the next call rather than latching.
      sessionPromise = null;
    }));
}
