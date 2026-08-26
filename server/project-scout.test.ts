import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoutProject } from "./project-scout";

function tempProject(setup: (cwd: string) => void): string {
  const cwd = join(tmpdir(), `mb-scout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(cwd, { recursive: true });
  setup(cwd);
  return cwd;
}

describe("scoutProject", () => {
  it("returns an error for missing folder", () => {
    const result = scoutProject("/definitely/not/here");
    expect(result.kind).toBe("missing");
  });

  it("returns an error when path is a file", () => {
    const cwd = tempProject(() => {});
    const file = join(cwd, "only.txt");
    writeFileSync(file, "x");
    const result = scoutProject(file);
    expect(result.kind).toBe("not_directory");
  });

  it("proposes a frontend + testing pair for a minimal React repo", () => {
    const cwd = tempProject((root) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18" }, devDependencies: { vitest: "^1" } }));
      writeFileSync(join(root, "tsconfig.json"), "{}");
      writeFileSync(join(root, "README.md"), "# Demo\n\nA tiny project for testing the scout.");
      mkdirSync(join(root, "src/components"), { recursive: true });
      mkdirSync(join(root, "__tests__"), { recursive: true });
      writeFileSync(join(root, "vitest.config.ts"), "export default {}");
    });
    const result = scoutProject(cwd);
    expect(result.kind).toBeUndefined();
    const manifest = result as Exclude<typeof result, ScoutError>;
    const roles = manifest.specialists.map((s) => s.role);
    expect(roles).toContain("Frontend");
    expect(roles).toContain("Testing");
    expect(roles).toContain("Documentation");
    expect(manifest.stack).toContain("react");
    expect(manifest.evidence.join(" ")).toContain("Demo");
    expect(manifest.lead.name).toBe("Compass");
  });

  it("falls back to a generalist for an empty project", () => {
    const cwd = tempProject(() => {});
    const result = scoutProject(cwd);
    expect(result.kind).toBeUndefined();
    const manifest = result as Exclude<typeof result, ScoutError>;
    expect(manifest.specialists).toHaveLength(1);
    expect(manifest.specialists[0]!.role).toBe("Generalist");
    expect(manifest.stack).toEqual([]);
  });
});

interface ScoutError {
  kind: string;
  message: string;
}