// multibot: startuje silnik (Python FastAPI z engine/) w trybie dev.
// Venv per-platform; ENGINE_URL w środowisku pomija lokalny start całkowicie.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(root, "engine");
const legacyData = join(root, "..", "multibot-engine-data");
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
env.MULTIBOT_ENGINE_DATA_DIR ??= existsSync(join(legacyData, "profiles"))
  ? legacyData
  : join(engine, "..", "engine-data");
// Keep Hermes and MultiBot profiles on same data root.
env.HERMES_HOME = env.MULTIBOT_ENGINE_DATA_DIR;

const child = spawn(venvPy, ["-m", "uvicorn", "server.app:app", "--port", "8700"], {
  cwd: engine,
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
