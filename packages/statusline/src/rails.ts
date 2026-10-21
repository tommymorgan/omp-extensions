import { z } from "zod";

const quotaWindow = z.object({
  remainingFraction: z.number().min(0).max(1),
  resetsAt: z.number().finite().optional(),
});
export const metricsSchema = z.object({
  compaction: z.union([
    z.object({ status: z.literal("enabled"), thresholdTokens: z.number().positive() }),
    z.object({ status: z.enum(["disabled", "unavailable"]) }),
  ]),
  generationRate: z.union([
    z.object({
      status: z.literal("available"),
      tokensPerSecond: z.number().finite().nonnegative(),
    }),
    z.object({ status: z.literal("unavailable") }),
  ]),
  quota: z.union([
    z.object({
      status: z.literal("available"),
      sevenDay: quotaWindow.optional(),
      fiveHour: quotaWindow.optional(),
    }),
    z.object({ status: z.literal("unavailable") }),
  ]),
});
const usageSchema = z.object({
  input: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  cacheWrite: z.number().finite().nonnegative(),
});
const responseSchema = z.object({
  role: z.literal("assistant"),
  stopReason: z.enum(["stop", "toolUse", "length"]),
  timestamp: z.number(),
  usage: z.unknown().optional(),
});

/** Select completed responses before inspecting usage: unknown usage still owns a slot. */
export function recentCache(messages: readonly unknown[]): number | undefined {
  const completed = messages
    .flatMap((message) => {
      const parsed = responseSchema.safeParse(message);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(-10);
  if (!completed.length) return undefined;
  let read = 0,
    total = 0;
  for (const message of completed) {
    const usage = usageSchema.safeParse(message.usage);
    if (!usage.success) return undefined;
    read += usage.data.cacheRead;
    total += usage.data.input + usage.data.cacheRead + usage.data.cacheWrite;
  }
  return total > 0 ? (100 * read) / total : undefined;
}
export function percentage(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}
export function contextMeter(
  compaction: z.infer<typeof metricsSchema>["compaction"],
  used: number | undefined,
): string {
  if (compaction.status === "disabled") return "off";
  if (compaction.status !== "enabled" || used === undefined || !Number.isFinite(used) || used < 0)
    return "unavailable";
  const ratio = used / compaction.thresholdTokens;
  const halfCells = Math.min(24, Math.max(0, Math.floor(ratio * 24)));
  const full = Math.floor(halfCells / 2),
    half = halfCells % 2;
  return `${"━".repeat(full)}${half ? "╸" : ""}\x1b[2m${"─".repeat(12 - full - half)}\x1b[22m ${percentage(ratio * 100)}`;
}
export function resetCountdown(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "reset unavailable";
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60000));
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  if (days) return `reset ${days}d ${hours}h`;
  if (hours) return `reset ${hours}h ${rest}m`;
  return `reset ${rest}m`;
}
export function upperMetrics(
  metrics: z.infer<typeof metricsSchema>,
  cache: number | undefined,
  used: number | undefined,
  now: number,
): string {
  const rate =
    metrics.generationRate.status === "available"
      ? `${Number(metrics.generationRate.tokensPerSecond.toFixed(1))} tok/s`
      : "— tok/s";
  const fields = [
    rate,
    `💰 ${cache === undefined ? "unavailable" : percentage(cache)}`,
    contextMeter(metrics.compaction, used),
  ];
  if (metrics.quota.status === "unavailable") fields.push("Allowance unavailable");
  else {
    for (const [label, window] of [
      ["Week", metrics.quota.sevenDay],
      ["5h", metrics.quota.fiveHour],
    ] as const)
      if (window)
        fields.push(
          `${label} ${percentage(window.remainingFraction * 100)} left · ${resetCountdown(window.resetsAt, now)}`,
        );
  }
  return fields.join("  ·  ");
}
/** Terminal metadata must not inject escape sequences or extra rows. */
export function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
