# Dostęp zdalny i logowanie Google

Docelowy kształt: MultiBot stoi na **jednym** urządzeniu (tu: telefon s10e
z Termuksem). Każdy inny klient — przeglądarka, aplikacja desktopowa, telefon —
jest tylko powłoką: podajesz adres, logujesz się i masz pełny MultiBot. Klient
nie musi być w tej samej sieci ani w tym samym kraju.

Składa się to z dwóch rzeczy, niezależnych od siebie:

1. **Jak ruch dociera do serwera** — tunel wychodzący (`scripts/tunnel.sh`).
2. **Kto zostaje wpuszczony** — token dostępu albo konto Google właściciela.

## Stan na dziś

| Rzecz | Stan |
|---|---|
| Tunel z telefonu, dostęp z dowolnej sieci | działa, sprawdzone end-to-end |
| Logowanie tokenem przez tunel | działa |
| Ekran komputera bota (noVNC po WebSocket) przez tunel | działa |
| Weryfikacja tokenu Google po stronie serwera | gotowa (`server/firebase-auth.ts`) |
| Przycisk „Sign in with Google" w przeglądarce | gotowy, włącza się sam po konfiguracji |
| Logowanie Google w aplikacji mobilnej | **nie zrobione** — patrz „Świadome luki" |

Sprawdzone przez tunel: `api/bots` bez tokenu `401`, z tokenem `200`, UI `200`,
a `wss://…/computer/vnc/websockify` oddaje `RFB 003.008`.

## Krok 1 — projekt Firebase (jednorazowo, wymaga Twojego konta Google)

1. <https://console.firebase.google.com> → **Add project**, dowolna nazwa.
   Google Analytics możesz pominąć.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**.
   Jako *Project support email* wybierz swój adres.
3. **Project settings → General → Your apps → Web (`</>`)**, zarejestruj apkę.
   Ze snippetu potrzebujesz dwóch wartości: `projectId` i `apiKey`.
4. **Project settings → General → Your apps → SDK setup** albo
   <https://console.cloud.google.com/apis/credentials> → **OAuth 2.0 Client IDs**
   → wpis typu *Web client (auto created by Google Service)*. Skopiuj
   **Client ID** (kończy się na `.apps.googleusercontent.com`).
5. Do **Authorized JavaScript origins** tego klienta dopisz adres, spod którego
   będziesz się logować (patrz krok 2 — musi być stały).
6. W Firebase: **Authentication → Settings → Authorized domains** dopisz tę samą
   domenę.

Wpisz trzy wartości do `~/.openmausbot/config.json` na serwerze:

```json
"firebase": {
  "projectId": "twoj-projekt",
  "apiKey": "AIza…",
  "clientId": "…apps.googleusercontent.com"
}
```

Potem zrestartuj serwer (`sv restart multibot`). Ekran logowania sam pokaże
przycisk Google — sprawdza to trasą `GET /api/auth/status`.

`apiKey` i `clientId` są **publiczne z definicji**: przeglądarka musi je pokazać
Google. Bramką nie są one, tylko to, co serwer robi z odesłanym tokenem.

### Kolejność pierwszego logowania ma znaczenie

`authorizeOwner` wiąże **pierwszy** UID jako właściciela i tylko wtedy, gdy
żądanie idzie z loopbacka albo niesie znany token dostępu. To celowe: bez tego
pierwszy przechodzień z internetu przejąłby serwer.

Praktycznie: **pierwsze** logowanie Google zrób w przeglądarce, która ma już
wpisany token (czyli tej, w której normalnie pracujesz). Kolejne urządzenia
logują się samym Google, bez tokenu.

## Krok 2 — publiczny adres

Na telefonie **stoi już usługa runit `cloudflared`**, wyłączona (plik `down`).
Czeka wyłącznie na token nazwanego tunelu:

```
$PREFIX/var/service/cloudflared/run
  exec cloudflared tunnel run --token-file $HOME/.cloudflared/token
```

Więc najkrótsza droga do STAŁEGO adresu (i jedyna, przy której działa logowanie
Google) wygląda tak:

1. <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel**
   → *Cloudflared*, nazwij `multibot`.
2. Skopiuj token instalacyjny (długi ciąg z komendy, którą pokaże panel).
3. Na telefonie:

   ```bash
   mkdir -p ~/.cloudflared
   printf '%s' 'WKLEJONY_TOKEN' > ~/.cloudflared/token
   chmod 600 ~/.cloudflared/token
   export SVDIR=$PREFIX/var/service
   rm $PREFIX/var/service/cloudflared/down    # usługa ma wstawać sama
   sv up cloudflared && sv status cloudflared
   ```

4. W panelu tunelu dodaj **Public hostname**: Twoja domena, typ `HTTP`, cel
   `localhost:8799`.

Ten adres wpisujesz raz w kroku 1 (punkty 5 i 6) i masz spokój.

### Wariant bez konta, na jeden raz

Szybki tunel (bez konta, adres losowy przy każdym starcie):

```bash
~/multibot/scripts/tunnel.sh
```

Do logowania Google to **nie wystarczy** — Google i Firebase wymagają wpisania
domeny na listę dozwolonych, a losowa domena zmienia się przy każdym restarcie.
Token dostępu działa tędy bez zastrzeżeń.

Sprawdzone tą drogą (adres losowy, tunel po teście zdjęty): `api/bots` bez
tokenu `401`, z tokenem `200`, UI `200`, `wss://…/computer/vnc/websockify`
oddaje `RFB 003.008`.

## Bezpieczeństwo, wprost

Publiczny adres znaczy, że każdy może zapukać. Za bramką stoją Twoje boty,
pliki, terminal komputera bota i klucze API dostawców. Bramka to:

- **token dostępu** — 64 znaki, jeden dla całej instalacji, jedzie w nagłówku
  albo w ciasteczku; albo
- **konto Google właściciela** — tylko UID zapisany jako `firebase.ownerUid`.

Dopóki nie skończysz kroku 1, jedyną barierą jest token. Dlatego tunel **nie
stoi domyślnie** — uruchamiasz go świadomie, jedną komendą.

Token rotujesz z UI (`AppSettingsPanel`) albo trasą `POST /api/auth/token/rotate`.
Rotacja zrywa wszystkie aktywne sesje.

## Świadome luki

- **Logowanie Google w aplikacji mobilnej.** Google blokuje OAuth w WebView
  Androida (`disallowed_useragent`), więc ekran webowy tam nie zadziała. Trzeba
  natywnego `expo-auth-session` i przekazania ciasteczka do WebView — osobny
  kawałek pracy. Do tego czasu telefon loguje się tokenem, tak jak dotąd.
- **Electron.** `electron/oauth-loopback.mjs` ma gotową obsługę callbacku na
  loopbacku, ale `buildAuthUrl` nie ma jeszcze czego budować. Aplikacja
  desktopowa pokazuje UI serwera, więc logowanie Google działa w niej tą samą
  drogą, co w przeglądarce — osobnego flow potrzebuje dopiero logowanie
  systemowe poza oknem.
- **Parowanie kodem QR** ma gotowy serwer (`POST /api/pair/start`, `/claim`),
  ale nie ma ekranu z kodem w UI hosta.
