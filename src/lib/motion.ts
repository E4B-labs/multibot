export type MotionMode = "full" | "reduced";

export const DEFAULT_MOTION_MODE: MotionMode = "full";
const KEY = "multibot-motion";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readMotionMode(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): MotionMode {
  try {
    return storage?.getItem(KEY) === "reduced" ? "reduced" : DEFAULT_MOTION_MODE;
  } catch {
    return DEFAULT_MOTION_MODE;
  }
}

export function applyMotionMode(mode: MotionMode): void {
  document.documentElement.dataset.motion = mode;
  try {
    browserStorage()?.setItem(KEY, mode);
  } catch {
    /* storage blocked — mode still applies for this session */
  }
}

export function motionIsReduced(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced";
}
