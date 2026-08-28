// multibot: panel „Serwer i urządzenia" wywoływany z 3-kropek w nagłówku
// czatu (prawy górny róg). Przeniesiony tu z zakładki Narzędzia w Ustawieniach
// aplikacji, żeby odszumić tamtą sekcję — wszystkie akcje związane z kontem,
// serwerem i parowaniem urządzeń mają jedno miejsce.
import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import {
  AccessTokenSettings,
  InstallAppSettings,
  PairDeviceSettings,
  WorkspaceAccessSettings,
} from "./AppSettingsPanel";

export function ServerAccessPanel() {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const close = () => dispatch({ type: "toggleServerAccess", open: false });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={close}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/60"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
            {polish ? "Serwer i urządzenia" : "Server & devices"}
          </h2>
          <button
            onClick={close}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label={polish ? "Zamknij" : "Close"}
          >
            <X size={18} />
          </button>
        </div>
        <WorkspaceAccessSettings />
        <AccessTokenSettings />
        <PairDeviceSettings />
        <InstallAppSettings />
      </div>
    </div>
  );
}
