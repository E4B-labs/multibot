// multibot: wybór mikrofonu — jedna preferencja aplikacji, trzymana lokalnie
// jak język i skórka. Dotyczy wyłącznie MultiBota: nie ruszamy urządzenia
// domyślnego w systemie, tylko mówimy, które urządzenie ma otwierać ta
// aplikacja, kiedy sięga po mikrofon.
//
// Logika siedzi tutaj, a nie w komponencie, bo cała trudność jest w danych z
// przeglądarki: bez zgody na mikrofon `enumerateDevices` zwraca urządzenia bez
// nazw, Chromium dokłada dwa pseudo-urządzenia („default", „communications"),
// a wybrany mikrofon potrafi zniknąć po wypięciu z gniazda.

/** Pusty ciąg = „to, co system uważa za domyślne". Zapisujemy go celowo
 *  zamiast konkretnego id: gdy ktoś przepnie mikrofon w Windowsie, wybór ma
 *  pójść za nim, a nie zostać na starym urządzeniu. */
export const SYSTEM_DEFAULT_MICROPHONE = "";

const KEY = "multibot-microphone";

/** Chromium wystawia obok prawdziwych urządzeń dwa aliasy na domyślne. Mamy
 *  własną pozycję „Domyślny systemowy", więc byłyby to duplikaty. */
const PSEUDO_DEVICES = new Set(["default", "communications"]);

export interface MicrophoneOption {
  id: string;
  label: string;
}

/** Tyle z `MediaDeviceInfo`, ile naprawdę czytamy — dzięki temu testy podają
 *  zwykłe obiekty, bez udawania całego API przeglądarki. */
export interface MicrophoneDevice {
  kind: string;
  deviceId: string;
  label?: string;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readMicrophoneId(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): string {
  try {
    return storage?.getItem(KEY) ?? SYSTEM_DEFAULT_MICROPHONE;
  } catch {
    return SYSTEM_DEFAULT_MICROPHONE;
  }
}

export function writeMicrophoneId(
  id: string,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = browserStorage(),
): void {
  try {
    if (id === SYSTEM_DEFAULT_MICROPHONE) storage?.removeItem(KEY);
    else storage?.setItem(KEY, id);
  } catch {
    /* zapis zablokowany — wybór zadziała do końca tej sesji */
  }
}

/** Lista do rozwijanego pola: najpierw pozycja domyślna, potem urządzenia w
 *  kolejności z systemu. Urządzenia bez nazwy (brak zgody na mikrofon) dostają
 *  numer, żeby dało się je w ogóle rozróżnić. */
export function microphoneOptions(devices: readonly MicrophoneDevice[], polish: boolean): MicrophoneOption[] {
  const inputs = devices.filter((d) => d.kind === "audioinput" && !PSEUDO_DEVICES.has(d.deviceId) && d.deviceId !== "");
  const options: MicrophoneOption[] = [
    { id: SYSTEM_DEFAULT_MICROPHONE, label: polish ? "Domyślny systemowy" : "System default" },
  ];
  inputs.forEach((device, index) => {
    const named = (device.label ?? "").trim();
    options.push({
      id: device.deviceId,
      label: named || (polish ? `Mikrofon ${index + 1}` : `Microphone ${index + 1}`),
    });
  });
  return options;
}

/** Zapisane id po odpięciu urządzenia wskazuje w pustkę, a pole wyboru
 *  pokazałoby wtedy pustą pozycję. Wracamy wtedy na domyślne. */
export function resolveMicrophoneId(saved: string, devices: readonly MicrophoneDevice[]): string {
  if (saved === SYSTEM_DEFAULT_MICROPHONE) return SYSTEM_DEFAULT_MICROPHONE;
  const known = devices.some((d) => d.kind === "audioinput" && d.deviceId === saved);
  return known ? saved : SYSTEM_DEFAULT_MICROPHONE;
}

/** Ograniczenie dla `getUserMedia`. Przy domyślnym oddajemy `true`, bo
 *  `deviceId: { exact: "" }` nie pasowałby do niczego i zgłosiłby błąd. */
export function microphoneConstraint(id: string): true | MediaTrackConstraints {
  return id === SYSTEM_DEFAULT_MICROPHONE ? true : { deviceId: { exact: id } };
}

/** Czy nazwy urządzeń są już widoczne. Przeglądarka ukrywa je do pierwszej
 *  zgody na mikrofon, więc dopóki są puste, pokazujemy przycisk proszący
 *  o dostęp zamiast listy „Mikrofon 1, Mikrofon 2". */
export function microphoneLabelsHidden(devices: readonly MicrophoneDevice[]): boolean {
  const inputs = devices.filter((d) => d.kind === "audioinput");
  return inputs.length > 0 && inputs.every((d) => !(d.label ?? "").trim());
}

/** Otwiera wybrany mikrofon. Jedno miejsce, przez które aplikacja sięga po
 *  wejście audio, żeby wybór z ustawień obowiązywał wszędzie tak samo. */
export async function openMicrophone(id: string = readMicrophoneId()): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: microphoneConstraint(id) });
}
