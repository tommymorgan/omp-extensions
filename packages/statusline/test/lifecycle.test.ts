import { afterAll, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { describeFailure, launchCompanion, readReady, updateCompanion } from "../src/lifecycle";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "statusline-lifecycle-"));
afterAll(() => fs.rm(root, { recursive: true, force: true }));
async function executable(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, contents);
  await fs.chmod(file, 0o755);
  return file;
}
const stock = await executable(
  path.join(root, "official-bin/omp"),
  '#!/bin/sh\nif [ "$1" = --version ]; then echo omp/18.12.7; else exit 27; fi\n',
);
const options = {
  stock,
  root: path.join(root, "state"),
  assets: path.resolve(import.meta.dir, ".."),
};
test("failed official update names actual commands and leaves bootstrap unavailable", async () => {
  await expect(updateCompanion(options)).rejects.toThrow("official updater failed");
  expect(await readReady(options.root)).toBeUndefined();
  const report = await describeFailure(options, "probe", "unavailable");
  expect(report).toContain(`${stock} (18.12.7)`);
  expect(report).toContain("Companion customization unavailable");
  await expect(launchCompanion(options, ["--version"])).rejects.toThrow(
    "Recovery: omp-statusline update",
  );
});
test("source lookup failure after stock update cannot expose a ready reference", async () => {
  const successStock = await executable(
    path.join(root, "updated-bin/omp"),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo omp/18.12.7; else exit 0; fi\n',
  );
  await expect(
    updateCompanion({ ...options, stock: successStock }, async () => {
      throw new Error("immutable source mapping unavailable");
    }),
  ).rejects.toThrow("immutable source mapping unavailable");
  expect(await readReady(options.root)).toBeUndefined();
});
test("official updater cannot redirect an explicitly selected stock to another PATH executable", async () => {
  const foreign = await executable(
    path.join(root, "foreign-stock"),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo omp/18.12.7; else touch '${root}/wrong-target-updated'; fi\n`,
  );
  await expect(updateCompanion({ ...options, stock: foreign })).rejects.toThrow(
    "refusing an ambiguous update target",
  );
  expect(
    await fs.stat(path.join(root, "wrong-target-updated")).catch(() => undefined),
  ).toBeUndefined();
});
test("ready reference verifies the whole owned bundle and rejects asset or path substitution", async () => {
  const state = path.join(root, "integrity");
  const bundle = path.join(state, "bundle-aaaaaaaa");
  await fs.mkdir(bundle, { recursive: true });
  await Bun.write(path.join(bundle, "overlay.json"), '{"companion":true}');
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = JSON.stringify({
    version: "18.12.6",
    source: "a".repeat(40),
    patch: "fixture",
    files: [{ path: "overlay.json", sha256: digest('{"companion":true}') }],
  });
  await Bun.write(path.join(bundle, "manifest.json"), manifest);
  await Bun.write(
    path.join(state, "ready.json"),
    JSON.stringify({ bundle: path.basename(bundle), sha256: digest(manifest) }),
  );
  await Bun.write(path.join(bundle, "overlay.json"), "{}");
  await expect(readReady(state)).rejects.toThrow("Verified bundle assets changed");
  await Bun.write(
    path.join(state, "ready.json"),
    JSON.stringify({ bundle: "../other", sha256: digest(manifest) }),
  );
  await expect(readReady(state)).rejects.toThrow();
});
test("concurrent updater cannot replace an active owner's lock or ready reference", async () => {
  await fs.mkdir(path.join(options.root, "update.lock"));
  await expect(updateCompanion(options)).rejects.toThrow("Another companion update owns");
  expect((await fs.stat(path.join(options.root, "update.lock"))).isDirectory()).toBe(true);
  await fs.rmdir(path.join(options.root, "update.lock"));
});

test.skipIf(!process.env.STATUSLINE_VERIFIED_BUNDLE)(
  "altered verified runtime bundle is rejected by the real launcher before execution",
  async () => {
    const bundleSource = process.env.STATUSLINE_VERIFIED_BUNDLE;
    if (!bundleSource) throw new Error("Explicit compiled bundle is required");
    const state = path.join(root, "compiled-integrity");
    const bundle = path.join(state, path.basename(bundleSource));
    await fs.mkdir(state);
    await fs.cp(bundleSource, bundle, { recursive: true, dereference: true });
    const manifest = await fs.readFile(path.join(bundle, "manifest.json"));
    await Bun.write(
      path.join(state, "ready.json"),
      JSON.stringify({
        bundle: path.basename(bundle),
        sha256: createHash("sha256").update(manifest).digest("hex"),
      }),
    );
    const overlay = path.join(bundle, "statusline/overlay.json");
    await fs.chmod(overlay, 0o644);
    await Bun.write(overlay, "{}");
    const child = Bun.spawn(
      ["bun", path.resolve(import.meta.dir, "../bin/omp-statusline"), "--version"],
      {
        env: { ...process.env, OMP_STATUSLINE_STOCK: stock, OMP_STATUSLINE_ROOT: state },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // The test owns this copy; restore writable modes only so its normal cleanup can remove it.
    async function writable(directory: string) {
      await fs.chmod(directory, 0o755);
      for (const entry of await fs.readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(path.join(directory, entry.name));
    }
    await writable(bundle);
    expect(exit).not.toBe(0);
    expect(stderr).toContain("Verified bundle assets changed");
    expect(stdout).not.toContain("omp/");
  },
  30000,
);
