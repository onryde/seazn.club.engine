// Toolchain pins the app repo (onryde/seazn.club) held over the engine until the split, and retired with it. At the tag engine-split-base
// (5a67fbf37d25675c683bbc91785bba5bacd93714) apps/web/src/__tests__/toolchain.test.ts read packages/engine/tsconfig.json and
// packages/engine/eslint.config.mjs; the package left that repository and the published tarball ships neither file, so the app cannot pin
// them any more (ledger docs/superpowers/specs/engine-split/ledgers/2b.json, 2b A3: "engine twin owed" on the ES2022 case, and the
// ban-ts-comment case "has no engine twin"). Both pins live here now, beside the files they read. Titles are the tag's, " (engine)" appended.
//
// Sandbox rule (test/stryker-sandbox-safe.test.ts): this file imports ESLint, so it must reach NOTHING under src/ (nor test/layout.ts)
// through its static imports. It reads the repository's own config files by path and imports only tree-budget.ts.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { FLOOR_MS } from "./tree-budget.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("toolchain: compile target", () => {
  it("the engine targets ES2022, matching apps/web (engine)", () => {
    // The tag stripped whole-line `//` comments and parsed; a tsconfig is JSONC. A form this strip cannot read makes JSON.parse throw, which
    // is a loud red, never a silent pass.
    const stripJsonComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
    const tsconfig = JSON.parse(stripJsonComments(readFileSync(join(ENGINE, "tsconfig.json"), "utf8"))) as {
      compilerOptions?: { target?: string };
    };
    expect(tsconfig.compilerOptions, "tsconfig.json has compilerOptions").toBeDefined();
    expect(tsconfig.compilerOptions?.target).toBe("ES2022");
  });
});

describe("toolchain: suppression policy", () => {
  /**
   * Both halves of the rule are load-bearing and they fail differently (the tag's comment, kept).
   *
   * `"ts-ignore": true` is the ban itself. `"ts-expect-error": "allow-with-description"` is what keeps the escape hatch usable: set it to
   * `true` as well and every suppression is illegal, which does not make the codebase safer, it makes people delete the rule. Asserting
   * only the first half lets the second be weakened or dropped in silence.
   *
   * The tag read eslint.config.mjs as TEXT and matched the rule with a regex. That passes on a rule left in a comment, and on a rule a later
   * config block switches back off. This asks ESLint itself for the config it will APPLY to a file, so the later blocks and the severity are
   * part of what is pinned, and it asks for one file from each config group (src, test, scripts, a config module) so a group that overrides
   * the rule is seen.
   */
  const FILES = ["src/core/index.ts", "test/toolchain.test.ts", "scripts/single-sport.ts", "eslint.config.mjs"];

  it("eslint.config.mjs bans @ts-ignore and keeps @ts-expect-error described (engine)", async () => {
    const eslint = new ESLint({ cwd: ENGINE });
    let checked = 0;
    for (const file of FILES) {
      const config = (await eslint.calculateConfigForFile(join(ENGINE, file))) as { rules?: Record<string, unknown> } | undefined;
      expect(config, `${file}: eslint.config.mjs applies no config to it (an ignored file proves nothing)`).toBeDefined();
      const rule = config?.rules?.["@typescript-eslint/ban-ts-comment"];
      expect(Array.isArray(rule), `${file}: no ban-ts-comment rule applies`).toBe(true);
      const [severity, options] = rule as [unknown, Record<string, unknown> | undefined];
      expect(severity, `${file}: ban-ts-comment is not an error`).toBe(2);
      expect(options, `${file}: ban-ts-comment carries no options`).toBeDefined();
      expect(options?.["ts-ignore"], `${file}: @ts-ignore is not banned`).toBe(true);
      expect(options?.["ts-expect-error"], `${file}: @ts-expect-error is not "allow-with-description"`).toBe("allow-with-description");
      checked++;
    }
    // anti-vacuity: a loop over no files, or one that skipped a file, would pass on anything
    expect(checked).toBe(FILES.length);
    expect(checked).toBeGreaterThan(0);
  }, FLOOR_MS); // the first `new ESLint` loads the package's whole flat config: ~5 s under coverage (pack-proof.test.ts carries the same note)
});
