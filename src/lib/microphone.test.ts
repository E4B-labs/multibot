import { describe, expect, it } from "vitest";
import {
  SYSTEM_DEFAULT_MICROPHONE,
  microphoneConstraint,
  microphoneLabelsHidden,
  microphoneOptions,
  readMicrophoneId,
  resolveMicrophoneId,
  writeMicrophoneId,
  type MicrophoneDevice,
} from "./microphone";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const devices: MicrophoneDevice[] = [
  { kind: "audioinput", deviceId: "default", label: "Domyślne - Zestaw słuchawkowy" },
  { kind: "audioinput", deviceId: "communications", label: "Komunikacja - Zestaw słuchawkowy" },
  { kind: "audioinput", deviceId: "hs-1", label: "Zestaw słuchawkowy (Realtek)" },
  { kind: "audioinput", deviceId: "cam-1", label: "Mikrofon kamery" },
  { kind: "audiooutput", deviceId: "spk-1", label: "Głośniki" },
  { kind: "videoinput", deviceId: "vid-1", label: "Kamera" },
];

describe("wybór mikrofonu", () => {
  it("lista zaczyna się od domyślnego, a aliasy Chromium nie dublują pozycji", () => {
    const options = microphoneOptions(devices, true);
    expect(options[0]).toEqual({ id: SYSTEM_DEFAULT_MICROPHONE, label: "Domyślny systemowy" });
    expect(options.map((o) => o.id)).toEqual(["", "hs-1", "cam-1"]);
  });

  it("urządzenia bez nazwy dostają numer, więc dają się rozróżnić", () => {
    const bez: MicrophoneDevice[] = [
      { kind: "audioinput", deviceId: "a", label: "" },
      { kind: "audioinput", deviceId: "b" },
    ];
    expect(microphoneOptions(bez, true).map((o) => o.label)).toEqual([
      "Domyślny systemowy",
      "Mikrofon 1",
      "Mikrofon 2",
    ]);
    expect(microphoneOptions(bez, false)[1].label).toBe("Microphone 1");
  });

  it("wypięty mikrofon wraca na domyślny zamiast zostawiać puste pole", () => {
    expect(resolveMicrophoneId("hs-1", devices)).toBe("hs-1");
    expect(resolveMicrophoneId("hs-9", devices)).toBe(SYSTEM_DEFAULT_MICROPHONE);
    expect(resolveMicrophoneId(SYSTEM_DEFAULT_MICROPHONE, [])).toBe(SYSTEM_DEFAULT_MICROPHONE);
  });

  it("domyślny nie zostaje zapisany, żeby szedł za zmianą urządzenia w systemie", () => {
    const storage = memoryStorage();
    writeMicrophoneId("hs-1", storage);
    expect(readMicrophoneId(storage)).toBe("hs-1");
    writeMicrophoneId(SYSTEM_DEFAULT_MICROPHONE, storage);
    expect(storage.map.size).toBe(0);
    expect(readMicrophoneId(storage)).toBe(SYSTEM_DEFAULT_MICROPHONE);
  });

  it("brak pamięci nie wywraca odczytu ani zapisu", () => {
    expect(readMicrophoneId(undefined)).toBe(SYSTEM_DEFAULT_MICROPHONE);
    expect(() => writeMicrophoneId("hs-1", undefined)).not.toThrow();
  });

  it("domyślny prosi o dowolne wejście, wybrany o dokładnie to jedno", () => {
    expect(microphoneConstraint(SYSTEM_DEFAULT_MICROPHONE)).toBe(true);
    expect(microphoneConstraint("hs-1")).toEqual({ deviceId: { exact: "hs-1" } });
  });

  it("puste nazwy znaczą brak zgody, ale pusta lista już nie", () => {
    expect(microphoneLabelsHidden([{ kind: "audioinput", deviceId: "a", label: "" }])).toBe(true);
    expect(microphoneLabelsHidden(devices)).toBe(false);
    expect(microphoneLabelsHidden([])).toBe(false);
  });
});
