import { describe, expect, test } from "bun:test";
import {
  contextMeter,
  recentCache,
  resetCountdown,
  upperMetrics,
  metricsSchema,
} from "../src/rails";
const response = (input: number, cacheRead: number, stopReason = "stop", extra = {}) => ({
  role: "assistant",
  timestamp: 1,
  stopReason,
  usage: { input, cacheRead, cacheWrite: 0, output: 1000000 },
  ...extra,
});
const enabled = { status: "enabled" as const, thresholdTokens: 1000 };
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
describe("recent completed model response window", () => {
  test("CACHE01 weights last ten responses rather than turns, old responses, output or mean", () =>
    expect(
      recentCache([
        response(100000, 0),
        response(0, 100000),
        ...Array.from({ length: 9 }, () => response(100, 900, "toolUse")),
        response(9000, 1000),
      ]),
    ).toBeCloseTo(47.8947368));
  test("CACHE02 shows two available responses immediately", () =>
    expect(recentCache([response(100, 900), response(900, 100)])).toBe(50));
  test("CACHE03 counts stop toolUse length and excludes failures and nonresponses", () =>
    expect(
      recentCache([
        response(100, 900),
        response(900, 100, "toolUse"),
        response(500, 500, "length"),
        response(0, 100000, "error"),
        response(900000, 0, "aborted"),
        { role: "toolResult", usage: { input: 0, cacheRead: 100000 } },
      ]),
    ).toBe(50));
  test("CACHE04 distinct branch projections preserve their own histories", () => {
    expect(recentCache([response(100, 900)])).toBe(90);
    expect(recentCache([response(800, 200)])).toBe(20);
  });
  test.each([undefined, { input: 0, cacheRead: 0, cacheWrite: 0 }, { input: 10, cacheRead: 100 }])(
    "CACHE05 missing buckets and zero denominators remain unavailable: %j",
    (usage) =>
      expect(
        recentCache([
          response(0, 100000),
          ...Array.from({ length: 10 }, () => response(0, 0, "stop", { usage })),
        ]),
      ).toBeUndefined(),
  );
});
describe("twelve cell budget meter", () => {
  test("METER01 uses compaction budget not model capacity", () =>
    expect(plain(contextMeter({ status: "enabled", thresholdTokens: 300000 }, 252000))).toBe(
      "━━━━━━━━━━── 84%",
    ));
  test.each([
    [0, 0, 0, 12, "0%"],
    [460, 5, 1, 6, "46%"],
    [500, 6, 0, 6, "50%"],
    [999, 11, 1, 0, "99.9%"],
    [1000, 12, 0, 0, "100%"],
    [1050, 12, 0, 0, "105%"],
  ] as const)(
    "METER02 %i tokens preserves exact text independently of half-cell quantization",
    (used, full, half, empty, percent) =>
      expect(plain(contextMeter(enabled, used))).toBe(
        `${"━".repeat(full)}${"╸".repeat(half)}${"─".repeat(empty)} ${percent}`,
      ),
  );
  test("METER03 settings model and compaction readings are current", () =>
    expect(
      [
        [150000, 300000],
        [150000, 200000],
        [150000, 250000],
        [50000, 250000],
      ].map(([used, budget]) =>
        plain(contextMeter({ status: "enabled", thresholdTokens: budget! }, used))
          .split(" ")
          .at(-1),
      ),
    ).toEqual(["50%", "75%", "60%", "20%"]));
  test("METER04 disabled and unavailable never reuse a threshold", () => {
    expect(contextMeter({ status: "disabled" }, 100)).toBe("off");
    expect(contextMeter({ status: "unavailable" }, 100)).toBe("unavailable");
    expect(contextMeter(enabled, undefined)).toBe("unavailable");
  });
});
const now = 1900000000000;
const metrics = (quota: unknown) =>
  metricsSchema.parse({
    compaction: enabled,
    generationRate: { status: "available", tokensPerSecond: 45.5 },
    quota,
  });
test("QUOTA01 uses remaining allowance and independent reported reset instants", () => {
  const text = upperMetrics(
    metrics({
      status: "available",
      sevenDay: { remainingFraction: 0.41, resetsAt: now + (5 * 24 + 5) * 3600000 },
      fiveHour: { remainingFraction: 0.74, resetsAt: now + 192 * 60000 },
    }),
    50,
    460,
    now,
  );
  expect(plain(text)).toContain("Week 41% left · reset 5d 5h");
  expect(text).toContain("5h 74% left · reset 3h 12m");
  expect(text).toContain("45.5 tok/s");
  expect(text).toContain("💰 50%");
});
test("QUOTA02 omitted windows stay absent known percentages survive absent reset", () => {
  const text = upperMetrics(
    metrics({ status: "available", sevenDay: { remainingFraction: 0.41 } }),
    undefined,
    undefined,
    now,
  );
  expect(text).toContain("Week 41% left · reset unavailable");
  expect(text).not.toContain("5h");
  expect(upperMetrics(metrics({ status: "unavailable" }), 50, 0, now)).toContain(
    "Allowance unavailable",
  );
});
test("QUOTA03 elapsed clock preserves exhausted zero", () => {
  const value = metrics({
    status: "available",
    sevenDay: { remainingFraction: 0.04, resetsAt: now + 120 * 60000 },
    fiveHour: { remainingFraction: 0, resetsAt: now + 30 * 60000 },
  });
  const text = upperMetrics(value, 50, 0, now + 5 * 60000);
  expect(text).toContain("Week 4% left · reset 1h 55m");
  expect(text).toContain("5h 0% left · reset 25m");
  expect(resetCountdown(now - 1, now)).toBe("reset 0m");
});
