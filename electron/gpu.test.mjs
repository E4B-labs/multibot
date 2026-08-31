import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { GPU_COMMAND_LINE_SWITCHES, gpuCommandLineSwitches, summarizeGpuFeatureStatus } = require("./gpu.cjs");

test("GPU policy enables Chromium rasterization switches only in hardware mode", () => {
  assert.deepEqual(gpuCommandLineSwitches(true), [...GPU_COMMAND_LINE_SWITCHES]);
  assert.deepEqual(gpuCommandLineSwitches(false), []);
});

test("runtime status reports active hardware compositing", () => {
  assert.deepEqual(
    summarizeGpuFeatureStatus(
      { gpu_compositing: "hardware_accelerated", rasterization: "hardware_accelerated" },
      true,
    ),
    {
      enabled: true,
      active: true,
      compositing: "hardware_accelerated",
      rasterization: "hardware_accelerated",
    },
  );
});

test("runtime status does not claim GPU use when disabled or unavailable", () => {
  assert.equal(summarizeGpuFeatureStatus({ gpu_compositing: "hardware_accelerated" }, false).active, false);
  assert.equal(summarizeGpuFeatureStatus({ gpu_compositing: "software", rasterization: "software" }, true).active, false);
  assert.deepEqual(summarizeGpuFeatureStatus(null, true), {
    enabled: true,
    active: false,
    compositing: "unknown",
    rasterization: "unknown",
  });
});
