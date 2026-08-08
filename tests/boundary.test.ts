import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * src/core has to run unchanged in three places: Node (the CLI harness),
 * vitest, and the Tauri webview. Two other layers already defend that —
 * tsconfig.core.json omits `lib.dom` and `@types/node`, and eslint.config.js
 * restricts imports and globals under src/core.
 *
 * This file is the third layer, and the only one that keeps working if someone
 * relaxes the other two. It reads the configs and the source directly.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readJsonc(relPath: string): unknown {
  const raw = readFileSync(join(repoRoot, relPath), "utf8");
  // Our tsconfigs carry // comments explaining the boundary; strip them.
  const stripped = raw
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  return JSON.parse(stripped);
}

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("src/core purity boundary", () => {
  it("tsconfig.core.json exposes neither DOM nor Node ambient types", () => {
    const cfg = readJsonc("tsconfig.core.json") as {
      compilerOptions: { lib: string[]; types: string[] };
    };

    // `types: []` is what keeps @types/node from leaking in. Without it,
    // `process` and `Buffer` compile fine in core and only fail in the webview.
    expect(cfg.compilerOptions.types).toEqual([]);

    const libs = cfg.compilerOptions.lib.map((l) => l.toLowerCase());
    expect(libs.some((l) => l.includes("dom"))).toBe(false);
    expect(libs).toContain("es2023");
  });

  it("no file under src/core imports Tauri, Node, React, or the model runtime", () => {
    const files = walk(join(repoRoot, "src", "core"));
    expect(files.length).toBeGreaterThan(0);

    // Matches `from "x"`, `import "x"`, and `import("x")`.
    const importRe = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

    const forbidden = [
      { test: (s: string) => s.startsWith("@tauri-apps/"), why: "Tauri" },
      { test: (s: string) => s.startsWith("node:"), why: "a Node builtin" },
      { test: (s: string) => s === "react" || s.startsWith("react/"), why: "React" },
      {
        test: (s: string) => s === "react-dom" || s.startsWith("react-dom/"),
        why: "React DOM",
      },
      { test: (s: string) => s.startsWith("@huggingface/"), why: "the model runtime" },
      { test: (s: string) => s.startsWith("onnxruntime"), why: "the ONNX runtime" },
    ];

    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(importRe)) {
        const spec = match[1];
        if (spec === undefined) continue;
        for (const rule of forbidden) {
          if (rule.test(spec)) {
            const rel = file.slice(repoRoot.length).replace(/\\/g, "/");
            violations.push(`${rel} imports ${rule.why} ("${spec}")`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("the vitest suite runs in a non-UTC timezone", () => {
    // Date bugs that matter (parsing a date-only string as local midnight)
    // are invisible when the test host is UTC, which every CI runner is.
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });
});
