// multibot: offline structural check for G6 install paths; never starts services.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const read = (name) => readFileSync(join(root, name), "utf8");
const must = (condition, message) => { if (!condition) throw new Error(message); };

const dockerfile = read("Dockerfile.selfhost");
const compose = read("docker-compose.selfhost.yml");
const entrypoint = read("scripts/docker-entrypoint.sh");
const start = read("scripts/start-multibot.sh");
const linux = read("scripts/install-linux.sh");
const termux = read("scripts/install-termux.sh");

must(existsSync(join(root, "public", "manifest.webmanifest")), "PWA manifest missing");
must(dockerfile.includes("--host 127.0.0.1") || start.includes("127.0.0.1:8700"), "engine loopback pin missing");
must(!compose.includes("8700:"), "compose publishes engine port");
must(entrypoint.includes("start-multibot.sh"), "docker entrypoint bypasses common launcher");
must(start.includes("dist-server/index.js"), "common launcher missing built harness");
must(dockerfile.includes("pnpm build:server"), "container omits server build");
must(dockerfile.includes("SLAFY_BROWSER_HEADLESS=1"), "container browser needs headless mode");
must(linux.includes("--dry-run") && linux.includes("--self-test"), "linux dry-run/self-test missing");
must(linux.includes('run docker compose -f "$ROOT/docker-compose.selfhost.yml" up -d --build'), "Docker installer only prints command");
must(linux.includes('pnpm --dir "$ROOT" build:server'), "Linux installer omits server build");
must(termux.includes("termux-services") && termux.includes(".termux/boot"), "Termux reboot persistence missing");
must(termux.includes("python-ensurepip-wheels") && termux.includes("--system-site-packages"), "Termux native Python prerequisites missing");
must(termux.includes("termux-services/svlogger"), "Termux service logger missing");
must(termux.includes('pnpm --dir "$ROOT" build:server'), "Termux installer omits server build");
must(linux.includes("tailscale serve --bg --yes http://127.0.0.1:8799"), "Linux Tailscale guidance missing");
must(termux.includes("tailscale serve --bg --yes http://127.0.0.1:8799"), "Termux Tailscale guidance missing");
console.log("self-host install paths: OK (no services started)");
