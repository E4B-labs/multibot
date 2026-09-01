// multibot: runtime silnika dla spakowanej apki. Installer NIE wozi Pythona
// (~120 MB rozpakowane + przeglądarka Playwrighta ~150 MB) — ściąga go przy
// pierwszym starcie do katalogu danych użytkownika.
//
// Układ katalogu docelowego (`--target`):
//   python/        python-build-standalone (pin niżej), z pipem w środku
//   hermes-agent/  źródła Hermesa na SHA z requirements.txt — editable, więc
//                  ten katalog musi zostać na stałe, nie w tempie
//   browsers/      PLAYWRIGHT_BROWSERS_PATH (domyślny jest na C:)
//   .provisioned   znacznik z pinami — jest = runtime gotowy, pomiń wszystko
//
// Idempotentne per krok: każdy sprawdza swój artefakt i wychodzi, więc przerwane
// pobieranie wznawia się od miejsca, w którym padło.
//
// Ręcznie:  node scripts/provision-engine.mjs --target D:\tmp\f11-runtime
// Z apki:   electron/main.mjs forkuje to przy braku python/ w userData.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Piny. python-build-standalone: tag = data wydania, `install_only` = gotowe
// drzewo `python/` (wariant `_stripped` gubi symbole, których chce debugger).
const PYTHON_TAG = "20260807";
const PYTHON_ASSET = "cpython-3.12.13+20260807-x86_64-pc-windows-msvc-install_only.tar.gz";
const PYTHON_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_TAG}/${PYTHON_ASSET}`;
// Ten sam SHA co w engine/requirements.txt i MULTIBOT.md. Tarball zamiast
// `git clone` — na maszynie użytkownika gita może nie być wcale.
const HERMES_SHA = "17688f994e6c4c681f8dd3d160b210ffe49aa273";
const HERMES_URL = `https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${HERMES_SHA}`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg("--target", process.env.OMB_ENGINE_RUNTIME);
if (!target) {
  console.error("provision-engine: brak --target <katalog> (albo OMB_ENGINE_RUNTIME w env)");
  process.exit(1);
}
const requirements = arg("--requirements", join(ROOT, "engine", "requirements.txt"));
if (!existsSync(requirements)) {
  console.error(`provision-engine: brak requirements.txt: ${requirements}`);
  process.exit(1);
}

const pythonExe =
  process.platform === "win32" ? join(target, "python", "python.exe") : join(target, "python", "bin", "python3");
const hermesDir = join(target, "hermes-agent");
const browsersDir = join(target, "browsers");
const marker = join(target, ".provisioned");

const t0 = Date.now();
const log = (msg) => console.log(`[provision +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

function run(cmd, args, env = {}, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      // TMP/TEMP w dół drzewa: pip i playwright rozpakowują się przez temp, a
      // domyślny temp użytkownika bywa na zapchanym dysku systemowym.
      env: { ...process.env, TMP: join(target, "tmp"), TEMP: join(target, "tmp"), ...env },
      stdio: "inherit",
      shell: false,
      cwd,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  // .part + rename: przerwane pobieranie nie zostawia pliku, który następny
  // przebieg wziąłby za kompletny
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
}

/**
 * Rozpakowuje `<into>/<relArchive>` w `into`. tar jest w System32 od Windows 10
 * 1803, ale w PATH może stać GNU tar z Git Basha — a ten w argumencie `-f`
 * czyta `D:\...` jako `host:ścieżka` i próbuje połączenia zdalnego. Stąd cwd +
 * ścieżka względna zamiast `-C`: bez dwukropka obie implementacje są zgodne.
 */
async function untar(relArchive, into) {
  mkdirSync(into, { recursive: true });
  await run("tar", ["-xzf", relArchive.replaceAll("\\", "/")], {}, into);
}

const pip = (...args) =>
  // --no-cache-dir: cache pipa domyślnie ląduje w %LOCALAPPDATA% (dysk
  // systemowy) i po instalacji jest już tylko śmieciem
  run(pythonExe, ["-m", "pip", "install", "--no-cache-dir", ...args], { PIP_DISABLE_PIP_VERSION_CHECK: "1" });

async function main() {
  if (existsSync(marker)) {
    log(`runtime już gotowy: ${target}`);
    return;
  }
  mkdirSync(join(target, "dl"), { recursive: true });
  // TMP/TEMP z run() muszą istnieć zanim ruszy pierwsze dziecko — playwright
  // woła mkdtemp() wprost w tym katalogu i nie tworzy go po drodze
  mkdirSync(join(target, "tmp"), { recursive: true });

  if (!existsSync(pythonExe)) {
    const tgz = join(target, "dl", PYTHON_ASSET);
    if (!existsSync(tgz)) {
      log(`pobieram ${PYTHON_ASSET}`);
      await download(PYTHON_URL, tgz);
    }
    log("rozpakowuję pythona");
    await untar(join("dl", PYTHON_ASSET), target); // archiwum ma w środku katalog `python/`
  }

  log("pip install -r requirements.txt");
  await pip("-r", requirements);

  if (!existsSync(hermesDir)) {
    const tgz = join(target, "dl", "hermes-agent.tar.gz");
    if (!existsSync(tgz)) {
      log(`pobieram hermes-agent @ ${HERMES_SHA.slice(0, 7)}`);
      await download(HERMES_URL, tgz);
    }
    log("rozpakowuję hermes-agent");
    await untar(join("dl", "hermes-agent.tar.gz"), target);
    const unpacked = readdirSync(target).find((d) => d.startsWith("hermes-agent-"));
    if (!unpacked) throw new Error("hermes-agent: archiwum nie zawiera katalogu hermes-agent-*");
    renameSync(join(target, unpacked), hermesDir);
  }
  // editable, bo backend budowy Hermesa odrzuca wheel/sdist (engine/requirements.txt)
  log("pip install -e hermes-agent");
  await pip("-e", hermesDir);

  log("playwright install chromium");
  await run(pythonExe, ["-m", "playwright", "install", "chromium"], { PLAYWRIGHT_BROWSERS_PATH: browsersDir });

  writeFileSync(marker, JSON.stringify({ python: PYTHON_ASSET, hermes: HERMES_SHA, at: new Date().toISOString() }, null, 2));
  rmSync(join(target, "dl"), { recursive: true, force: true });
  rmSync(join(target, "tmp"), { recursive: true, force: true });
  log(`gotowe: ${target}`);
}

main().catch((e) => {
  console.error(`[provision] ${e.message}`);
  process.exit(1);
});
