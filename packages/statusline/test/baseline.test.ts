import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import {
  checkoutOfficialSource,
  resolveOfficialSource,
  stageOfficialBaseline,
  verifyBaselineBinary,
} from "../src/baseline";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "statusline-contract-"));
  roots.push(value);
  return value;
}
async function git(cwd: string, ...args: string[]) {
  return (await exec(["git", ...args], { cwd })).stdout.trim();
}
async function repository(version = "18.12.6") {
  const cwd = await root();
  await fs.mkdir(path.join(cwd, "packages/coding-agent"), { recursive: true });
  await Bun.write(
    path.join(cwd, "packages/coding-agent/package.json"),
    JSON.stringify({ version }),
  );
  await Bun.write(path.join(cwd, "bun.lock"), "owned fixture lock\n");
  await git(cwd, "init", "-q");
  await git(cwd, "add", ".");
  await git(
    cwd,
    "-c",
    "user.name=Owned Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  await git(cwd, "tag", "v18.12.6");
  return cwd;
}
async function executable(cwd: string, body: string) {
  const file = path.join(cwd, "owned-executable");
  await Bun.write(file, `#!/bin/sh\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

test("SRC02: missing immutable mapping never substitutes a default branch", async () => {
  const repo = await repository();
  await expect(resolveOfficialSource("18.12.7", repo)).rejects.toThrow(
    "No immutable source mapping",
  );
  expect(await git(repo, "rev-parse", "HEAD")).toHaveLength(40);
});

test("SRC02: selected tag whose source declares another release is rejected before dependencies", async () => {
  const repo = await repository("18.12.5");
  const stagingRoot = await root();
  await Bun.write(path.join(stagingRoot, "current"), "retained companion");
  await expect(
    stageOfficialBaseline({ version: "18.12.6", stagingRoot, repository: repo }),
  ).rejects.toThrow("Source release mismatch");
  expect(await fs.readdir(stagingRoot)).toEqual(["current"]);
  expect(await Bun.file(path.join(stagingRoot, "current")).text()).toBe("retained companion");
});

test("SRC02: resolution is immutable across a moved tag and checkout", async () => {
  const repo = await repository();
  const source = await resolveOfficialSource("18.12.6", repo);
  await Bun.write(path.join(repo, "new-file"), "moved");
  await git(repo, "add", ".");
  await git(
    repo,
    "-c",
    "user.name=Owned Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "moved",
  );
  await git(repo, "tag", "-f", "v18.12.6");
  await expect(checkoutOfficialSource(source, path.join(await root(), "checkout"))).rejects.toThrow(
    "Source mapping changed",
  );
});

test("SRC01: exact checkout records the locked dependencies of the resolved commit", async () => {
  const repo = await repository();
  const source = await resolveOfficialSource("18.12.6", repo);
  const checkout = path.join(await root(), "source");
  const provenance = await checkoutOfficialSource(source, checkout);
  expect(provenance.revision).toBe(await git(repo, "rev-parse", "HEAD"));
  expect(provenance.lockChecksum).toBe(
    createHash("sha256").update("owned fixture lock\n").digest("hex"),
  );
  expect(await git(checkout, "diff", "--name-only")).toBe("");
});

test("SRC01: wrong staged version fails before worker smoke", async () => {
  const cwd = await root();
  const binary = await executable(
    cwd,
    'if [ "$1" = "--version" ]; then echo 18.12.5; else touch smoke-ran; fi',
  );
  await expect(verifyBaselineBinary(binary, "18.12.6", cwd)).rejects.toThrow(
    "Staged version mismatch",
  );
  expect(await Bun.file(path.join(cwd, "smoke-ran")).exists()).toBe(false);
});
