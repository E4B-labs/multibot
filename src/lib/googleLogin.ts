// multibot (A1): logowanie Google w przeglądarce, bez ani jednej nowej paczki.
//
// Droga jest trzyczęściowa i każda część robi dokładnie jedno:
//   1. Google Identity Services (skrypt z accounts.google.com) oddaje token ID
//      Google — samo GIS nie wie nic o Firebase.
//   2. `accounts:signInWithIdp` Firebase'a wymienia go na token ID Firebase'a.
//      To zwykły POST, więc SDK Firebase'a (i jego 300 kB) jest niepotrzebne.
//   3. `POST /api/auth/firebase/session` weryfikuje ten token po stronie
//      serwera (`server/firebase-auth.ts`) i odsyła ciasteczko sesji.
//
// `apiKey` i `clientId` są publiczne z definicji — bez nich przeglądarka nie
// przedstawi się Google. Bramką jest to, co serwer robi Z tokenem: wiąże
// pierwszego właściciela i wpuszcza tylko jego.
import { authFetch } from "./auth";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const IDP_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp";

export interface GoogleLoginConfig {
  configured: true;
  projectId: string;
  apiKey: string;
  clientId: string;
}

export interface AuthStatus {
  google: GoogleLoginConfig | { configured: false };
  session: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status");
  if (!res.ok) throw new Error(`auth status ${res.status}`);
  return (await res.json()) as AuthStatus;
}

/** Ładuje GIS raz na dokument; kolejne wywołania dostają ten sam `Promise`. */
let gisPromise: Promise<void> | null = null;
export function loadGoogleIdentity(): Promise<void> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${GIS_SRC}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in script could not be loaded."));
    document.head.appendChild(script);
  });
  return gisPromise;
}

/** Token ID Google zamieniony na token ID Firebase'a. */
export async function exchangeForFirebaseIdToken(googleIdToken: string, apiKey: string): Promise<string> {
  const res = await fetch(`${IDP_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
      requestUri: location.origin,
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { idToken?: string; error?: { message?: string } };
  if (!res.ok || !body.idToken) throw new Error(body.error?.message || `Firebase sign-in failed (${res.status})`);
  return body.idToken;
}

/** Wymienia token Firebase'a na ciasteczko sesji tego serwera. */
export async function startDeviceSession(idToken: string, label: string): Promise<void> {
  // `authFetch`, nie `fetch`: pierwsze logowanie właściciela przechodzi tylko z
  // loopbacka albo z już znanym tokenem dostępu (`authorizeOwner`), a token
  // siedzi w `localStorage` tej przeglądarki.
  const res = await authFetch("/api/auth/firebase/session", {
    method: "POST",
    body: JSON.stringify({ idToken, label }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `Sign-in rejected (${res.status})`);
}

interface GisCredentialResponse {
  credential: string;
}

/** Rysuje przycisk Google w `target` i domyka całą drogę do sesji. */
export async function renderGoogleButton(
  target: HTMLElement,
  cfg: GoogleLoginConfig,
  onDone: (error?: Error) => void,
): Promise<void> {
  await loadGoogleIdentity();
  const gis = (window as unknown as { google?: any }).google;
  if (!gis?.accounts?.id) throw new Error("Google sign-in is unavailable.");
  gis.accounts.id.initialize({
    client_id: cfg.clientId,
    callback: (response: GisCredentialResponse) => {
      void (async () => {
        try {
          const idToken = await exchangeForFirebaseIdToken(response.credential, cfg.apiKey);
          await startDeviceSession(idToken, navigator.userAgent.slice(0, 60));
          onDone();
        } catch (e) {
          onDone(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    },
  });
  target.replaceChildren();
  gis.accounts.id.renderButton(target, { theme: "filled_black", size: "large", width: 320, text: "signin_with" });
}
