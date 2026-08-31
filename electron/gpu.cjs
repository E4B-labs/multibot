// Electron GPU policy and runtime status helpers.
// Kept Electron-free so the policy is testable with plain Node.

const GPU_COMMAND_LINE_SWITCHES = Object.freeze([
  "enable-gpu-rasterization",
  "enable-accelerated-2d-canvas",
]);

function gpuCommandLineSwitches(enabled) {
  return enabled === true ? [...GPU_COMMAND_LINE_SWITCHES] : [];
}

function summarizeGpuFeatureStatus(featureStatus, enabled) {
  const status = featureStatus && typeof featureStatus === "object" ? featureStatus : {};
  const compositing = typeof status.gpu_compositing === "string" ? status.gpu_compositing : "unknown";
  const rasterization = typeof status.rasterization === "string" ? status.rasterization : "unknown";
  return {
    enabled: enabled === true,
    active: enabled === true && compositing === "hardware_accelerated",
    compositing,
    rasterization,
  };
}

module.exports = { GPU_COMMAND_LINE_SWITCHES, gpuCommandLineSwitches, summarizeGpuFeatureStatus };
