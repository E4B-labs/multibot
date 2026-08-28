// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  interface Window {
    /** Wstrzykiwane przez proxy trybu zdalnego (electron/remote-ui.mjs) do
     * `index.html`. Nieobecne wszędzie indziej: w przeglądarce i pod
     * Electronem z lokalnym serwerem. */
    __MULTIBOT_REMOTE__?: true;
    ogb?: {
      screenFrame(): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** Saves a remote host and switches the shell to it (onboarding
       * "connect"). Optional — older shells don't expose it, so callers must
       * feature-detect and fall back to a plain navigation. */
      addRemoteHost?(url: string): Promise<void>;
      /** Unread-conversation count for the taskbar badge. Fire-and-forget;
       * absent in plain browsers, so callers must feature-detect. */
      setUnreadCount?(count: number): void;
      exportDiagnostics?(): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}
