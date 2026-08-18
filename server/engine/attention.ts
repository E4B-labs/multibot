// multibot: D7 — bot silnika czekający na człowieka (login, captcha, pytanie).
// Silnik ogłasza to eventem `attention` na WS (`engine/server/app.py`:
// `{type:"attention", bot_id, reason|null}`), a harness ma z tego zrobić stan
// bota w swoim store.
//
// Klient WS jest ręczny (~70 linii), bo zależności zero: handshake idzie przez
// `node:http` upgrade, a z ramkowania RFC 6455 potrzebujemy tekstu, ping→pong
// i close. Pong NIE jest opcjonalny — uvicorn pinguje co 20 s i zrywa
// połączenie, gdy nikt nie odpowie.
//
// Połączenia NIE poprzedzamy `ensureEngine()`: to zapaliłoby silnik przy każdym
// starcie harnessu i skasowało leniwy kontrakt z F2. Zamiast tego pętla
// reconnectu cicho próbuje, aż silnik się pojawi.
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import { engineBaseUrl } from "./supervisor.ts";

const RETRY_MS = 5_000;

/** Strumień bajtów → ramki. Fragmentów (opcode 0) nie sklejamy: eventy silnika
 * to krótkie JSON-y, które Starlette wysyła jednym kawałkiem. */
function frameReader(onFrame: (opcode: number, payload: Buffer) => void) {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (mask) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
        payload = copy;
      }
      buf = buf.subarray(off + len);
      onFrame(opcode, payload);
    }
  };
}

/** Ramka klient→serwer MUSI być maskowana (RFC 6455 §5.3). Używamy jej tylko
 * do pongów, więc payload zawsze mieści się w 125 bajtach. */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const body = payload.subarray(0, 125);
  const mask = randomBytes(4);
  const out = Buffer.alloc(6 + body.length);
  out[0] = 0x80 | opcode;
  out[1] = 0x80 | body.length;
  mask.copy(out, 2);
  for (let i = 0; i < body.length; i++) out[6 + i] = body[i] ^ mask[i % 4];
  return out;
}

export interface AttentionWatch {
  /** Id botów silnika, o które pytamy przy każdym (re)connekcie — WS niesie
   * wyłącznie zmiany od teraz, a uwaga mogła zapalić się przy zamkniętej apce. */
  engineBotIds: () => string[];
  onAttention: (engineBotId: string, reason: string | null) => void;
}

/** Startuje pętlę nasłuchu; zwraca funkcję zatrzymującą. */
export function watchEngineAttention(watch: AttentionWatch): () => void {
  let stopped = false;
  let socket: Duplex | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const retry = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => ((timer = null), open()), RETRY_MS);
    timer.unref?.();
  };

  /** Stan sprzed połączenia: silnik trzyma go w `attention.json`. */
  const reconcile = async (baseUrl: string) => {
    for (const id of watch.engineBotIds()) {
      try {
        const res = await fetch(`${baseUrl}/api/bots/${encodeURIComponent(id)}/attention`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) continue; // 404 = bot istnieje tylko w harnessie
        const body = (await res.json()) as { reason?: string | null };
        watch.onAttention(id, body.reason ?? null);
      } catch {
        /* silnik zniknął w trakcie — następny connect spróbuje znowu */
      }
    }
  };

  const open = () => {
    if (stopped) return;
    const baseUrl = engineBaseUrl();
    const target = new URL(baseUrl);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: "GET",
      path: "/api/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("upgrade", (_res, sock) => {
      if (stopped) return sock.destroy();
      socket = sock;
      sock.unref?.();
      const read = frameReader((opcode, payload) => {
        if (opcode === 9) return void sock.write(maskedFrame(0xa, payload)); // ping → pong
        if (opcode === 8) return sock.destroy(); // close → reconnect
        if (opcode !== 1) return;
        try {
          const event = JSON.parse(payload.toString("utf8")) as { type?: string; bot_id?: string; reason?: string | null };
          if (event.type === "attention" && event.bot_id) watch.onAttention(event.bot_id, event.reason ?? null);
        } catch {
          /* nie-JSON na kanale eventów — nic, czego umiemy użyć */
        }
      });
      sock.on("data", read);
      sock.on("error", () => sock.destroy());
      sock.on("close", () => ((socket = null), retry()));
      void reconcile(baseUrl);
    });
    req.on("response", (res) => (res.resume(), retry())); // odmowa upgrade'u
    req.on("error", retry); // silnik jeszcze nie wstał
    req.end();
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.destroy();
  };
}
