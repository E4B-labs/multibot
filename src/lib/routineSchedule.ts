// multibot R1: cron/interval string ↔ preset (hourly/daily/weekly/monthly).
// Dependency-free (no React/DOM) so both the UI component and its vitest
// suite can import it directly. Mirrors what the two routine backends
// actually emit:
//   - engine (`cron.jobs.parse_schedule`) normalizes "every 1h" → "every 60m"
//   - harness (`server/routines.ts`) stores the interval string verbatim
// so the interval check compares total minutes, not the literal string.
export type Preset = "hourly" | "daily" | "weekly" | "monthly";
export type PresetOrUnknown = Preset | "manual" | "unknown";

export interface ScheduleFields {
  minute: number;
  hour: number;
  weekday: number; // 0=Sunday..6=Saturday (cron convention)
  monthDay: number; // 1-31
}

export interface ParsedSchedule extends ScheduleFields {
  preset: PresetOrUnknown;
}

export const PRESETS: Preset[] = ["hourly", "daily", "weekly", "monthly"];

export function isKnownPreset(preset: PresetOrUnknown): preset is Preset {
  return (PRESETS as string[]).includes(preset);
}

const DEFAULT_FIELDS: ScheduleFields = { minute: 0, hour: 9, weekday: 1, monthDay: 1 };
const isInt = (field: string) => /^\d+$/.test(field);
const EVERY = /^every\s+(\d+)\s*([mhd])$/i;

/** null/empty schedule = manual routine (no automatic run). */
export function parseSchedule(schedule: string | null | undefined): ParsedSchedule {
  if (!schedule || !schedule.trim()) return { preset: "manual", ...DEFAULT_FIELDS };
  const s = schedule.trim();

  const interval = EVERY.exec(s);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2].toLowerCase();
    const minutes = unit === "h" ? amount * 60 : unit === "d" ? amount * 1440 : amount;
    return minutes === 60
      ? { preset: "hourly", ...DEFAULT_FIELDS }
      : { preset: "unknown", ...DEFAULT_FIELDS };
  }

  const parts = s.split(/\s+/);
  if (parts.length !== 5) return { preset: "unknown", ...DEFAULT_FIELDS };
  const [min, hr, dom, mon, dow] = parts;
  if (mon !== "*") return { preset: "unknown", ...DEFAULT_FIELDS };

  // "M * * * *" — fixed minute, everything else wildcard.
  if (isInt(min) && hr === "*" && dom === "*" && dow === "*" && +min <= 59) {
    return { preset: "hourly", minute: +min, hour: DEFAULT_FIELDS.hour, weekday: DEFAULT_FIELDS.weekday, monthDay: DEFAULT_FIELDS.monthDay };
  }
  if (!isInt(min) || !isInt(hr)) return { preset: "unknown", ...DEFAULT_FIELDS };
  const minute = +min;
  const hour = +hr;
  if (minute > 59 || hour > 23) return { preset: "unknown", ...DEFAULT_FIELDS };

  // "M H * * *" — daily.
  if (dom === "*" && dow === "*") {
    return { preset: "daily", minute, hour, weekday: DEFAULT_FIELDS.weekday, monthDay: DEFAULT_FIELDS.monthDay };
  }
  // "M H * * D" — weekly.
  if (dom === "*" && isInt(dow) && +dow >= 0 && +dow <= 6) {
    return { preset: "weekly", minute, hour, weekday: +dow, monthDay: DEFAULT_FIELDS.monthDay };
  }
  // "M H DAY * *" — monthly.
  if (dow === "*" && isInt(dom) && +dom >= 1 && +dom <= 31) {
    return { preset: "monthly", minute, hour, weekday: DEFAULT_FIELDS.weekday, monthDay: +dom };
  }
  return { preset: "unknown", ...DEFAULT_FIELDS };
}

export function buildSchedule(preset: Preset, fields: ScheduleFields): string {
  const { minute: m, hour: h, weekday: d, monthDay: dm } = fields;
  if (preset === "hourly") return "every 1h";
  if (preset === "daily") return `${m} ${h} * * *`;
  if (preset === "weekly") return `${m} ${h} * * ${d}`;
  return `${m} ${h} ${dm} * *`; // monthly
}
