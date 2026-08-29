// multibot: strefa czasowa bota. Domyślnie wykrywana z systemu, ale można
// wybrać dowolną z listy IANA — bot ma wtedy pracować w tej strefie, choćby
// komputer stał gdzie indziej.
//
// Cała lista idzie z przeglądarki (`Intl.supportedValuesOf`), więc nie
// starzeje się razem z kodem: nowe strefy dochodzą z aktualizacją silnika.

/** Pusty ciąg = „wykryj automatycznie". Zapisujemy go zamiast wykrytej nazwy,
 *  żeby po przewiezieniu komputera do innego kraju wybór poszedł za zegarem,
 *  a nie został na starej strefie. */
export const AUTO_TIMEZONE = "";

const KEY = "multibot-timezone";

/** Awaryjna lista na wypadek środowiska bez `Intl.supportedValuesOf` (starsze
 *  silniki). Lepiej dać kilka sensownych stref niż puste pole wyboru. */
const FALLBACK_ZONES = [
  "Africa/Cairo",
  "America/Chicago",
  "America/Los_Angeles",
  "America/New_York",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Warsaw",
  "UTC",
];

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Strefa, w której naprawdę stoi ten komputer. */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function listTimeZones(): string[] {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const zones = supported?.("timeZone");
    if (zones && zones.length > 0) return zones;
  } catch {
    /* silnik bez tego API — schodzimy na listę awaryjną */
  }
  return FALLBACK_ZONES;
}

export function readTimeZone(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): string {
  try {
    return storage?.getItem(KEY) ?? AUTO_TIMEZONE;
  } catch {
    return AUTO_TIMEZONE;
  }
}

export function writeTimeZone(
  zone: string,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = browserStorage(),
): void {
  try {
    if (zone === AUTO_TIMEZONE) storage?.removeItem(KEY);
    else storage?.setItem(KEY, zone);
  } catch {
    /* zapis zablokowany — wybór zadziała do końca tej sesji */
  }
}

/** Strefa do faktycznego użycia: wybrana albo wykryta. */
export function resolveTimeZone(saved: string = readTimeZone(), detected: string = detectTimeZone()): string {
  return saved === AUTO_TIMEZONE ? detected : saved;
}

/** „Europe/Warsaw" → „Europe/Warsaw", ale „Africa/Addis_Ababa" → „Africa/Addis
 *  Ababa". Podkreślenia w nazwach IANA są tylko zaszłością formatu. */
export function zoneLabel(zone: string): string {
  return zone.split("_").join(" ");
}

/** Formattery trzymamy w pamięci podręcznej per strefa. Lista ma ponad 400
 *  pozycji i przerysowuje się przy każdym naciśnięciu klawisza w wyszukiwarce —
 *  budowanie `Intl.DateTimeFormat` od nowa dla każdego wiersza byłoby wtedy
 *  odczuwalne. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** Godzina w danej strefie, 24-godzinna. Zwraca pusty ciąg dla strefy, której
 *  silnik nie zna — wiersz pokaże wtedy samą nazwę zamiast wywracać listę. */
export function zoneTime(zone: string, now: Date = new Date()): string {
  let formatter = FORMATTERS.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("pl-PL", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return "";
    }
    FORMATTERS.set(zone, formatter);
  }
  return formatter.format(now);
}

/** Znak bez ogonków i wielkości liter — żeby „lodz" znalazło „Łódź", a
 *  „addis ababa" znalazło „Africa/Addis_Ababa". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Filtr listy stref. Puste zapytanie oddaje całą listę w kolejności IANA —
 *  dokładnie tak, jak wygląda rozwinięta lista bez wpisanego szukania. */
export function filterTimeZones(zones: readonly string[], query: string): string[] {
  const needle = fold(query.trim());
  if (!needle) return [...zones];
  // Szukamy po nazwie z podkreśleniami i bez, bo użytkownik widzi wersję ze
  // spacjami i taką właśnie wpisze.
  return zones.filter((zone) => {
    const haystack = fold(zone) + " " + fold(zoneLabel(zone));
    return haystack.includes(needle);
  });
}
