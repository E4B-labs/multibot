// Preferencja akceleracji sprzętowej — czysty CJS, żeby dało się ją sprawdzić
// testem bez Electrona (ten sam podział co window-state.cjs).
//
// DOMYŚLNIE WYŁĄCZONA — decyzja Kacpra z 29.08. Electron sam z siebie
// akcelerację WŁĄCZA, więc to my musimy ją zdjąć: brak pliku, uszkodzony JSON
// i każda wartość spoza schematu muszą dawać „wyłączone". Inaczej pierwsze
// uruchomienie po aktualizacji zachowałoby się odwrotnie niż to, co panel
// pokazuje użytkownikowi.
//
// Czytane SYNCHRONICZNIE na starcie main.mjs, bo `app.disableHardwareAcceleration()`
// działa wyłącznie przed gotowością aplikacji — stąd zwykły plik JSON, a nie
// stan trzymany w rendererze.
const DEFAULT_ENABLED = false;

/** Wyłącznie jawne `true` włącza akcelerację. Wszystko inne — brak wartości,
 *  śmieci, zły typ — zostaje przy domyślnym wyłączeniu. */
function parseHardwareAcceleration(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return DEFAULT_ENABLED;
  }
  if (!value || typeof value !== "object") return DEFAULT_ENABLED;
  return value.hardwareAcceleration === true;
}

/** Preferencje po zmianie jednej wartości; reszta pliku zostaje nietknięta,
 *  żeby dopisanie kolejnej opcji nie kasowało poprzednich. */
function withHardwareAcceleration(raw, enabled) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    value = null;
  }
  const base = value && typeof value === "object" ? value : {};
  return { ...base, hardwareAcceleration: enabled === true };
}

module.exports = { DEFAULT_ENABLED, parseHardwareAcceleration, withHardwareAcceleration };
