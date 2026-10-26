import { describe, expect, test } from "bun:test";
import { lowerRail } from "../src/rails";

const separator = "  ·  ";
const prefix = ["16s", "⌂ junkman", "◉ GPT-6.1 Sol"];
const path = "▰ ~/src/agents";
const bookmark = "⎇ statusline-plan";
const identity = "omp-0123456789abcdef01234567";
const mail = `✉ ${identity}`;
const plain = (rows: string[]) => rows.map((row) => Bun.stripANSI(row));

describe("lower rail field allocation", () => {
  test("phone-width mail does not fragment a path or model that fits the terminal", () => {
    const rows = lowerRail(prefix, [path], mail, 40, separator);
    expect(rows.some((row) => row.includes(path))).toBe(true);
    expect(rows.some((row) => row.includes("GPT-6.1 Sol"))).toBe(true);
    expect(rows.at(-1)?.trimStart()).toBe(mail);
    expect(Bun.stringWidth(rows.at(-1) ?? "")).toBe(40);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.every((row) => Bun.stringWidth(row) <= 40)).toBe(true);
  });

  test("desktop grouping keeps the complete directory bookmark and mail on one physical row", () => {
    const rows = lowerRail(prefix, [path, bookmark], mail, 80, separator);
    const repositoryRow = rows.find((row) => row.includes(path) && row.includes(bookmark));
    expect(repositoryRow?.endsWith(mail)).toBe(true);
    expect(Bun.stringWidth(repositoryRow ?? "")).toBe(80);
    expect(rows.join(" ")).toContain("GPT-6.1 Sol");
  });

  test("a full fitting rail remains one row with mail at the right edge", () => {
    const rows = lowerRail(prefix, [path], mail, 96, separator);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startsWith([...prefix, path].join(separator))).toBe(true);
    expect(rows[0]?.endsWith(mail)).toBe(true);
    expect(Bun.stringWidth(rows[0] ?? "")).toBe(96);
  });

  test("when the repository group is too wide only a whole final fact moves beside mail", () => {
    const longPath = `▰ ~/src/${"directory-".repeat(5)}project`;
    const rows = lowerRail(prefix, [longPath, bookmark], mail, 80, separator);
    expect(rows.some((row) => row.includes(longPath))).toBe(true);
    expect(rows.at(-1)?.includes(bookmark)).toBe(true);
    expect(rows.at(-1)?.endsWith(mail)).toBe(true);
    expect(rows.every((row) => Bun.stringWidth(row) <= 80)).toBe(true);
  });

  test("an identity wider than the terminal wraps without losing characters or narrowing facts", () => {
    const longIdentity = `agent-${"0123456789abcdef".repeat(5)}-complete`;
    const rows = lowerRail(prefix, [path], `✉ ${longIdentity}`, 28, separator);
    expect(rows.join("")).toContain(longIdentity);
    expect(rows.some((row) => row.includes(path))).toBe(true);
    expect(rows.every((row) => Bun.stringWidth(row) <= 28)).toBe(true);
  });

  test("missing mail preserves whole facts without trailing separator-only rows", () => {
    const rows = lowerRail(prefix, [path, bookmark], undefined, 40, separator);
    expect(rows.some((row) => row.includes("GPT-6.1 Sol"))).toBe(true);
    expect(rows.some((row) => row.includes(path))).toBe(true);
    expect(rows.some((row) => row.includes(bookmark))).toBe(true);
    expect(rows.every((row) => !row.endsWith(separator) && !row.startsWith(separator))).toBe(true);
  });

  test("ANSI styling and wide path glyphs use terminal cells when aligning mail", () => {
    const styledPath = "\x1b[32m▰ ~/src/資料/🧭\x1b[0m";
    const styledMail = `\x1b[36m${mail}\x1b[0m`;
    const rows = lowerRail(prefix, [styledPath], styledMail, 52, "\x1b[2m  ·  \x1b[22m");
    const visible = plain(rows);
    const repositoryRow = visible.find((row) => row.includes("~/src/資料/🧭"));
    expect(repositoryRow?.endsWith(mail)).toBe(true);
    expect(Bun.stringWidth(rows.at(-1) ?? "")).toBe(52);
    expect(rows.every((row) => Bun.stringWidth(row) <= 52)).toBe(true);
  });
});
