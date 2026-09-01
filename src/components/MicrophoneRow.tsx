// multibot: wiersz „Mikrofon" w sekcji System (Ustawienia → Ogólne).
// Wybór dotyczy tylko tej aplikacji — urządzenie domyślne w Windowsie zostaje
// nietknięte, tak samo jak przy akceleracji sprzętowej.
import { useCallback, useEffect, useState } from "react";
import {
  SYSTEM_DEFAULT_MICROPHONE,
  microphoneLabelsHidden,
  microphoneOptions,
  openMicrophone,
  readMicrophoneId,
  resolveMicrophoneId,
  writeMicrophoneId,
  type MicrophoneDevice,
} from "@/lib/microphone";

export function MicrophoneRow({ polish }: { polish: boolean }) {
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [selected, setSelected] = useState<string>(() => readMicrophoneId());
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let list: MediaDeviceInfo[];
    try {
      list = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    setDevices(list);
    // Przed pierwszą zgodą Chromium oddaje urządzenia bez nazw i bez id.
    // Sprawdzanie zapisanego wyboru na takiej liście skasowałoby go za każdym
    // otwarciem ustawień, więc do czasu zgody go nie ruszamy.
    if (microphoneLabelsHidden(list)) return;
    const saved = readMicrophoneId();
    const resolved = resolveMicrophoneId(saved, list);
    if (resolved !== saved) writeMicrophoneId(resolved);
    setSelected(resolved);
  }, []);

  useEffect(() => {
    void refresh();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    // Wpięcie albo wypięcie mikrofonu w trakcie — lista ma się zgadzać z tym,
    // co faktycznie jest w komputerze.
    const onChange = () => void refresh();
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [refresh]);

  const grantAccess = async () => {
    setAsking(true);
    setError(null);
    try {
      const stream = await openMicrophone(SYSTEM_DEFAULT_MICROPHONE);
      stream.getTracks().forEach((track) => track.stop());
      await refresh();
    } catch {
      setError(
        polish
          ? "Brak dostępu do mikrofonu — zezwól na niego w ustawieniach prywatności systemu."
          : "No microphone access — allow it in your system privacy settings.",
      );
    } finally {
      setAsking(false);
    }
  };

  // Wybór zapisujemy od razu, a potem otwieramy urządzenie na moment, żeby od
  // razu było wiadomo, czy w ogóle da się z niego nagrywać. Cisza = działa.
  const choose = (id: string) => {
    setSelected(id);
    writeMicrophoneId(id);
    setError(null);
    void openMicrophone(id)
      .then((stream) => stream.getTracks().forEach((track) => track.stop()))
      .catch(() =>
        setError(
          polish
            ? "Nie udało się otworzyć tego mikrofonu. Sprawdź, czy jest podłączony i czy nie zajmuje go inny program."
            : "Could not open this microphone. Check that it is plugged in and not held by another app.",
        ),
      );
  };

  const options = microphoneOptions(devices, polish);
  const needsAccess = microphoneLabelsHidden(devices);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{polish ? "Mikrofon" : "Microphone"}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {polish
              ? "Urządzenie, z którego MultiBot nagrywa dźwięk."
              : "The device MultiBot records from."}
          </div>
        </div>
        <select
          value={selected}
          onChange={(event) => choose(event.target.value)}
          className="max-w-[220px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink focus:outline-none"
          aria-label={polish ? "Mikrofon" : "Microphone"}
        >
          {options.map((option) => (
            <option key={option.id || "default"} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {needsAccess && (
        <button
          type="button"
          onClick={() => void grantAccess()}
          disabled={asking}
          className="mt-2 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {asking
            ? polish
              ? "Czekam na zgodę…"
              : "Waiting for access…"
            : polish
              ? "Pokaż nazwy mikrofonów"
              : "Show microphone names"}
        </button>
      )}
      {error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
    </div>
  );
}
