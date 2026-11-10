// Engine CI sharding (the `engine-shard` jobs of .github/workflows/ci.yml): a shard runs ONE slice of the suite, so it sees only the
// code that slice executes and cannot judge a coverage threshold; the thresholds gate the MERGED coverage instead (the `engine` job's
// `vitest run --merge-reports --coverage`, which carries no `--shard`). vitest.config.ts withholds its thresholds from a sharded run
// and from nothing else. These tests pin both halves: which command lines count as a shard, and that the gate itself is still there.
//
// The numbers below are the policy vitest.config.ts's own comment cites (PROMPT-14 §4: at least 90% of lines across the engine, the
// fold kernel and the tiebreaker cascade fully covered), typed here on purpose: a threshold read back from the config under test
// would pass whatever the config said (docs/superpowers/TEST-STRATEGY.md, never derive an expected value from the code under test).
import { describe, expect, it } from "vitest";
import config, { COVERAGE_THRESHOLDS, coverageThresholds, isCoverageShard } from "../vitest.config.ts";

describe("isCoverageShard: which command lines run a slice of the suite", () => {
  // every spelling vitest's CLI accepts for a shard of a suite split in more than one, and what it must answer
  const SHARDS: Array<[string[], boolean]> = [
    [["--shard=1/3"], true],
    [["--shard=3/3"], true],
    [["--shard=2/2"], true],
    [["--shard", "2/3"], true],
    [["run", "--coverage", "--reporter=blob", "--shard=1/4"], true],
    [["--shard=1/10"], true],
    // a suite split in ONE is the whole suite: nothing is withheld
    [["--shard=1/1"], false],
    [["--shard", "1/1"], false],
    // not a shard at all: the plain run, the merge, and a look-alike flag
    [[], false],
    [["run", "--coverage"], false],
    [["run", "--merge-reports", "--coverage"], false],
    [["--shards=1/3"], false],
    [["--shard"], false],
    [["--shard=garbage"], false],
    [["--shard=1/"], false],
    [["--reporter=shard", "1/3"], false],
  ];

  it.each(SHARDS)("%j -> %s", (argv, expected) => {
    expect(isCoverageShard(argv)).toBe(expected);
  });

  it("checked every spelling, both answers among them (a table that answered one way throughout would prove nothing)", () => {
    expect(SHARDS.length).toBeGreaterThan(10);
    expect(SHARDS.some(([, e]) => e)).toBe(true);
    expect(SHARDS.some(([, e]) => !e)).toBe(true);
  });
});

describe("the coverage gate vitest.config.ts carries", () => {
  it("is the PROMPT-14 gate: 90% of lines overall, 100% of the fold kernel, the tiebreaker cascade and its write-side check", () => {
    expect(COVERAGE_THRESHOLDS).toEqual({
      lines: 90,
      "src/core/**/*.ts": { lines: 100 },
      "src/competition/tiebreakers.ts": { lines: 100 },
      "src/competition/cascade-rules.ts": { lines: 100 },
    });
  });

  it("is what a run that is not a shard enforces, and what a shard withholds", () => {
    expect(coverageThresholds(["run", "--coverage"])).toBe(COVERAGE_THRESHOLDS);
    expect(coverageThresholds(["run", "--merge-reports", "--coverage"])).toBe(COVERAGE_THRESHOLDS);
    expect(coverageThresholds(["run", "--coverage", "--shard=1/1"])).toBe(COVERAGE_THRESHOLDS);
    expect(coverageThresholds(["run", "--coverage", "--shard=1/3"])).toBeUndefined();
    expect(coverageThresholds(["run", "--coverage", "--shard", "3/3"])).toBeUndefined();
  });

  it("the config declares coverage over src, with the gate, or with none only because THIS process's own command line is a shard", () => {
    const coverage = (config as { test?: { coverage?: { include?: string[]; thresholds?: unknown; provider?: string } } }).test?.coverage;
    expect(coverage?.provider).toBe("v8");
    expect(coverage?.include).toEqual(["src/**/*.ts"]);
    // the config is evaluated in this process, so it answers for this process's argv: the test is a shard of the CI run, or it is not
    if (isCoverageShard(process.argv)) expect(coverage?.thresholds).toBeUndefined();
    else expect(coverage?.thresholds).toBe(COVERAGE_THRESHOLDS);
  });
});
