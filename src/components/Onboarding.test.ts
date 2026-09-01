import { describe, expect, it } from "vitest";
import { previousOnboardingStep } from "./Onboarding";

describe("onboarding navigation", () => {
  it("backs from server setup to choice and skips browser-only permissions", () => {
    expect(previousOnboardingStep("server", 0, true)).toEqual({ entry: "choice", step: 0 });
    expect(previousOnboardingStep("server", 5, false)).toEqual({ entry: "server", step: 3 });
    expect(previousOnboardingStep("server", 6, true)).toEqual({ entry: "server", step: 5 });
  });
});
