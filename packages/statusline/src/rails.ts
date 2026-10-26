import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
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
export function upperMetricFields(
  metrics: z.infer<typeof metricsSchema>,
  cache: number | undefined,
  used: number | undefined,
  now: number,
) {
  const rate =
    metrics.generationRate.status === "available"
      ? `${metrics.generationRate.tokensPerSecond.toFixed(1).padStart(5)} tok/s`
      : "    — tok/s";
  const fields: { text: string; tone: "success" | "warning" | "muted" | "error" }[] = [
    { text: `💰 ${cache === undefined ? "unavailable" : percentage(cache)}`, tone: "success" },
    { text: contextMeter(metrics.compaction, used), tone: "warning" },
  ];
  if (metrics.quota.status === "unavailable")
    fields.push({ text: "Allowance unavailable", tone: "muted" });
  else {
    for (const [label, window] of [
      ["Week", metrics.quota.sevenDay],
      ["5h", metrics.quota.fiveHour],
    ] as const)
      if (window)
        fields.push({
          text: `${label} ${percentage(window.remainingFraction * 100)} left · ${resetCountdown(window.resetsAt, now)}`,
          tone: window.remainingFraction === 0 ? "error" : "muted",
        });
  }
  return { rate, fields };
}

/** Plain semantic representation used by non-rendering consumers. */
export function upperMetrics(
  metrics: z.infer<typeof metricsSchema>,
  cache: number | undefined,
  used: number | undefined,
  now: number,
): string {
  const { rate, fields } = upperMetricFields(metrics, cache, used, now);
  return [rate, ...fields.map((field) => field.text)].join("  ·  ");
}

/** Pack whole facts before wrapping a field that is itself wider than the terminal. */
function wrapFields(fields: readonly string[], width: number, separator: string): string[] {
  const rows: string[] = [];
  let row = "";
  for (const field of fields) {
    if (!field) continue;
    const next = row ? row + separator + field : field;
    if (Bun.stringWidth(next) <= width) row = next;
    else {
      if (row) rows.push(row);
      const wrapped = wrapTextWithAnsi(field, width);
      rows.push(...wrapped.slice(0, -1));
      row = wrapped.at(-1) ?? "";
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** Sharing a row with mail must not narrow an otherwise fitting fact into fragments. */
export function lowerRail(
  prefix: readonly string[],
  repository: readonly string[],
  mail: string | undefined,
  width: number,
  separator: string,
): string[] {
  const columns = Math.max(1, width);
  const fields = [...prefix, ...repository].filter(Boolean);
  if (!mail) return wrapFields(fields, columns, separator);
  const mailWidth = Bun.stringWidth(mail);
  const leftWidth = columns - Bun.stringWidth(separator) - mailWidth;
  let left = fields.join(separator);
  let preceding: readonly string[] = [];
  if (Bun.stringWidth(left) > leftWidth) {
    left = repository.filter(Boolean).join(separator);
    preceding = prefix;
    if (!left || Bun.stringWidth(left) > leftWidth) {
      left = fields.at(-1) ?? "";
      preceding = fields.slice(0, -1);
    }
  }
  if (left && Bun.stringWidth(left) <= leftWidth)
    return [
      ...wrapFields(preceding, columns, separator),
      left + separator + " ".repeat(leftWidth - Bun.stringWidth(left)) + mail,
    ];
  const rows = wrapFields(fields, columns, separator);
  if (mailWidth <= columns) rows.push(" ".repeat(columns - mailWidth) + mail);
  else rows.push(...wrapTextWithAnsi(mail, columns));
  return rows;
}
