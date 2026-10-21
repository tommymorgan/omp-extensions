import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildBaselineBinary, stageOfficialBaseline, verifyBaselineBinary } from "../src/baseline";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "statusline-build-failure-"));
  roots.push(value);
  return value;
}
async function executable(cwd: string, body: string) {
  const file = path.join(cwd, "owned-executable");
  await Bun.write(file, `#!/bin/sh\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}
test("SRC03: missing toolchain is identified without allocating or promoting a candidate", async () => {
  const stagingRoot = await root();
  const previousPath = process.env.PATH;
  process.env.PATH = stagingRoot;
  try {
    await expect(stageOfficialBaseline({ version: "18.12.6", stagingRoot })).rejects.toThrow(
      "Missing required local tool: git",
    );
  } finally {
    process.env.PATH = previousPath;
  }
  expect(await fs.readdir(stagingRoot)).toEqual([]);
});

test("SRC03: supported build nonzero exit is identified and no copied binary appears", async () => {
  const source = await root();
  const candidate = await root();
  await Bun.write(
    path.join(source, "package.json"),
    JSON.stringify({ scripts: { "ci:release:build-binaries": "exit 27" } }),
  );
  await expect(buildBaselineBinary(source, candidate, "18.12.6")).rejects.toThrow(
    "supported binary build failed",
  );
  expect(await fs.readdir(candidate)).toEqual([]);
});

test("SRC03: worker failure cannot earn verification evidence", async () => {
  const cwd = await root();
  const binary = await executable(
    cwd,
    'if [ "$1" = "--version" ]; then echo 18.12.6; else exit 23; fi',
  );
  await expect(verifyBaselineBinary(binary, "18.12.6", cwd)).rejects.toThrow(
    "worker smoke gate failed",
  );
  expect(await Bun.file(path.join(cwd, "provenance.json")).exists()).toBe(false);
});

test("SRC03: smoke success exit without the existing worker completion marker is rejected", async () => {
  const cwd = await root();
  const binary = await executable(cwd, 'if [ "$1" = "--version" ]; then echo 18.12.6; fi');
  await expect(verifyBaselineBinary(binary, "18.12.6", cwd)).rejects.toThrow("no success marker");
});
