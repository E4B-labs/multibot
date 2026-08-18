// multibot: startuje silnik (Python FastAPI z engine/) w trybie dev.
// Venv per-platform; ENGINE_URL w środowisku pomija lokalny start całkowicie.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(root, "engine");
const legacyData = join(root, "..", "slafy-bot-data");
const venvPy =
  process.platform === "win32"
    ? join(engine, ".venv", "Scripts", "python.exe")
    : join(engine, ".venv", "bin", "python");

if (!existsSync(venvPy)) {
  console.error(
    `[engine] brak venv: ${venvPy}\n` +
      `[engine] utwórz: cd engine && uv venv .venv --python 3.12 && ` +
      `uv pip install --python ${process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python"} -r requirements.txt`,
  );
  process.exit(1);
}

const env = { ...process.env };
env.SLAFY_DATA_DIR ??= existsSync(join(legacyData, "profiles")) ? legacyData : join(engine, "..", "engine-data");
// Keep Hermes and Multibot profiles on same data root. Host-level HERMES_HOME
// (Windows defaults to C:) otherwise makes gateway read wrong config and exit 78.
env.HERMES_HOME = env.SLAFY_DATA_DIR;

const child = spawn(venvPy, ["-m", "uvicorn", "server.app:app", "--port", "8700"], {
  cwd: engine,
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
