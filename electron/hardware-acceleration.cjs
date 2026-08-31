// Hardware acceleration preference, kept Electron-free for unit tests.
// Electron decides this before app.whenReady(), so main.mjs reads the JSON
// preference synchronously during process startup.

// The normal desktop path keeps Chromium's GPU compositing/rasterization on.
const DEFAULT_ENABLED = true;

/** Only an explicit true or false changes the stored preference. Missing,
 * malformed, or wrongly typed data falls back to the enabled default. */
function parseHardwareAcceleration(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return DEFAULT_ENABLED;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ENABLED;
  if (!("hardwareAcceleration" in value)) return DEFAULT_ENABLED;
  return value.hardwareAcceleration === true;
}

/** Update one preference without deleting any other preferences. */
function withHardwareAcceleration(raw, enabled) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    value = null;
  }
  const base = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { ...base, hardwareAcceleration: enabled === true };
}

module.exports = { DEFAULT_ENABLED, parseHardwareAcceleration, withHardwareAcceleration };
