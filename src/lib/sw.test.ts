// Service worker uruchomiony w node z podstawionymi `self`, `caches` i `fetch`.
// Regres, który to łapie: kopia odpowiedzi robiona dopiero w `then` od
// `caches.open` trafiała na ciało już czytane przez przeglądarkę, `clone()`
// rzucał, powłoka w cache'u zostawała ta z pierwszej instalacji — czyli z
// czasów zepsutej paczki — i przy słabej sieci wracał z niej czarny ekran.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Handler = (event: any) => void;

function loadWorker(fetchMock: () => Promise<Response> = async () => new Response("BUNDLE", { status: 200 })) {
  const source = readFileSync(SW, "utf8");
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Response>();
  const key = (k: any) => (typeof k === "string" ? k : k.url);
  const cache = {
    addAll: async () => {},
    put: async (k: any, v: Response) => void store.set(key(k), v),
    match: async (k: any) => store.get(key(k)),
  };
  const caches = {
    // Cache API chodzi po dysku — rozwiązanie po makrozadaniu odwzorowuje to,
    // że przeglądarka zdąży zacząć czytać odpowiedź, zanim `open` wróci.
    open: () => new Promise<typeof cache>((done) => setTimeout(() => done(cache), 0)),
    match: async (k: any) => cache.match(k),
    keys: async () => [] as string[],
    delete: async () => true,
  };
  const self = {
    addEventListener: (type: string, fn: Handler) => void (handlers[type] = fn),
    location: { origin: "http://host" },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetchMock);
  return { handlers, store };
}

/** Co robi przeglądarka: bierze odpowiedź z `respondWith` i czyta jej ciało. */
async function respond(handler: Handler, request: any) {
  let answer: Promise<Response> | undefined;
  // Przeglądarka zaczyna czytać ciało od razu, gdy obietnica z `respondWith`
  // się rozwiąże — nie czeka, aż worker skończy swoje sprawy z cache'em.
  handler({
    request,
    respondWith: (p: Promise<Response>) => void (answer = p.then(async (r) => (await r.text(), r))),
  });
  if (!answer) return undefined;
  const response = await answer;
  await new Promise((r) => setTimeout(r, 10));
  return response;
}

// `multibot2/webui` nie serwuje własnego `sw.js` — po porcie plik ma milczeć,
// nie wywalać cudzej suity.
const SW = new URL("../../public/sw.js", import.meta.url);

describe.runIf(existsSync(SW))("service worker", () => {
  it("forces shell cache v5", () => {
    expect(readFileSync(SW, "utf8")).toContain('const CACHE = "multibot-shell-v5"');
  });

  it("zapisuje powłokę w cache'u mimo że przeglądarka czyta odpowiedź", async () => {
    const { handlers, store } = loadWorker();
    await respond(handlers.fetch, { method: "GET", url: "http://host/", mode: "navigate" });
    const cached = store.get("/index.html");
    expect(cached).toBeDefined();
    expect(await cached!.text()).toBe("BUNDLE");
  });

  it("zapisuje paczkę z /assets/ i nie podstawia HTML-a za skrypt", async () => {
    const { handlers, store } = loadWorker();
    const url = "http://host/assets/index-abc.js";
    await respond(handlers.fetch, { method: "GET", url, mode: "no-cors" });
    expect(await store.get(url)!.text()).toBe("BUNDLE");
  });

  it("nieudane pobranie paczki zostaje nieudane, nie oddaje powłoki jako skryptu", async () => {
    const { handlers } = loadWorker(async () => {
      throw new Error("offline");
    });
    let answer: Promise<Response> | undefined;
    handlers.fetch({
      request: { method: "GET", url: "http://host/assets/index-abc.js", mode: "no-cors" },
      respondWith: (p: Promise<Response>) => void (answer = p),
    });
    await expect(answer).rejects.toThrow("offline");
  });

  it("nie tyka /api/ ani obcego origins", async () => {
    const { handlers } = loadWorker();
    expect(await respond(handlers.fetch, { method: "GET", url: "http://host/api/bots", mode: "cors" })).toBeUndefined();
    expect(await respond(handlers.fetch, { method: "GET", url: "http://obcy/assets/x.js", mode: "no-cors" })).toBeUndefined();
  });
});
