// multibot R1: cron/interval ↔ preset parser. Lives under server/ because
// vitest.config's `include` is scoped to server/**/*.test.ts (no src/ test
// convention exists yet); the module under test is dependency-free so
// importing it here from a node environment is safe.
import { describe, expect, it } from "vitest";

import { buildSchedule, parseSchedule, PRESETS, type ScheduleFields } from "../src/lib/routineSchedule.ts";

const fields: ScheduleFields = { minute: 30, hour: 17, weekday: 5, monthDay: 21 };

describe("routine schedule preset parser", () => {
  it("round-trips every preset through build → parse", () => {
    for (const preset of PRESETS) {
      const schedule = buildSchedule(preset, fields);
      const parsed = parseSchedule(schedule);
      expect(parsed.preset).toBe(preset);
      if (preset !== "hourly") {
        expect(parsed.minute).toBe(fields.minute);
        expect(parsed.hour).toBe(fields.hour);
      }
      if (preset === "weekly") expect(parsed.weekday).toBe(fields.weekday);
      if (preset === "monthly") expect(parsed.monthDay).toBe(fields.monthDay);
    }
  });

  it("maps the legacy 'every 1h' interval form to hourly", () => {
    expect(parseSchedule("every 1h").preset).toBe("hourly");
    // engine's cron.jobs.parse_schedule normalizes "every 1h" → "every 60m"
    expect(parseSchedule("every 60m").preset).toBe("hourly");
  });

  it("recognizes the bare 'M * * * *' hourly cron form", () => {
    const parsed = parseSchedule("15 * * * *");
    expect(parsed.preset).toBe("hourly");
    expect(parsed.minute).toBe(15);
  });

  it("treats null/empty schedule as manual", () => {
    expect(parseSchedule(null).preset).toBe("manual");
    expect(parseSchedule("").preset).toBe("manual");
  });

  it("returns unknown for an unclassifiable cron instead of throwing", () => {
    expect(() => parseSchedule("*/7 3 * * *")).not.toThrow();
    expect(parseSchedule("*/7 3 * * *").preset).toBe("unknown");
    expect(parseSchedule("every 45m").preset).toBe("unknown");
    expect(parseSchedule("not a schedule").preset).toBe("unknown");
  });
});
