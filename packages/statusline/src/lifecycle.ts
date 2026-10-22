import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildBaselineBinary,
  checksum,
  stageOfficialBaseline,
  verifyBaselineBinary,
} from "./baseline";

const packageRoot = path.resolve(import.meta.dir, "..");
const release = z.string().regex(/^\d+\.\d+\.\d+$/);
const manifestSchema = z.object({
  version: release,
  source: z.string().regex(/^[a-f0-9]{40}$/),
  patch: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
const readySchema = z.object({
  bundle: z.string().regex(/^bundle-[a-f0-9-]+$/),
  sha256: z.string(),
});
const stagedSchema = z
  .object({
    candidate: z.string(),
    binary: z.string(),
    revision: z.string(),
    version: release,
  })
  .passthrough();
export const optionsSchema = z.object({
  stock: z.string(),
  root: z.string(),
  repository: z.string().optional(),
  assets: z.string().default(packageRoot),
});
export type Options = z.infer<typeof optionsSchema>;

async function run(command: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`${command[0]} exited ${exit}: ${stderr}\n${stdout}`);
  return stdout.trim();
}
export async function stockVersion(stock: string) {
  const resolved = await fs.realpath(stock);
  const version = (await run([resolved, "--version"], process.cwd())).replace(/^omp\//, "");
  return { command: resolved, version: release.parse(version) };
}
async function inventory(
  directory: string,
  prefix = "",
): Promise<z.infer<typeof manifestSchema>["files"]> {
  const result: z.infer<typeof manifestSchema>["files"] = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle symlink rejected: ${relative}`);
    if (entry.isDirectory()) result.push(...(await inventory(directory, relative)));
    else if (entry.isFile())
      result.push({ path: relative, sha256: await checksum(path.join(directory, relative)) });
    else throw new Error(`Unsupported bundle asset: ${relative}`);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function readReady(root: string) {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, "ready.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const ready = readySchema.parse(JSON.parse(text));
  const bundle = path.join(root, ready.bundle);
  if ((await fs.lstat(bundle)).isSymbolicLink())
    throw new Error("Ready bundle must be owned, not a symlink");
  const manifestFile = path.join(bundle, "manifest.json");
  if ((await checksum(manifestFile)) !== ready.sha256)
    throw new Error("Ready manifest checksum mismatch");
  const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestFile, "utf8")));
  const actual = (await inventory(bundle)).filter((file) => file.path !== "manifest.json");
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Verified bundle assets changed");
  return { bundle, manifest };
}
async function copyAssets(assets: string, bundle: string) {
  for (const name of [
    "src/extension.ts",
    "src/rails.ts",
    "overlay.json",
    "test/runtime",
    "test/api-runtime",
    "core.patch",
  ]) {
    const destination = path.join(bundle, "statusline", name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(path.join(assets, name), destination, { recursive: true, dereference: true });
  }
  await fs.mkdir(path.join(bundle, "statusline/node_modules"), { recursive: true });
  await fs.cp(
    await fs.realpath(path.join(assets, "node_modules/zod")),
    path.join(bundle, "statusline/node_modules/zod"),
    { recursive: true, dereference: true },
  );
  await fs.cp(path.resolve(assets, "../editor/src"), path.join(bundle, "editor/src"), {
    recursive: true,
    dereference: true,
  });
}
async function semanticGate(
  binary: string,
  bundle: string,
  baseline: string,
  version: string,
  proof: string,
) {
  await run(
    [
      "python3",
      path.join(bundle, "statusline/test/api-runtime/verify.py"),
      "--candidate",
      binary,
      "--baseline",
      baseline,
      "--expected-version",
      version,
      "--output",
      path.join(proof, "api"),
    ],
    proof,
  );
  await run(
    [
      "python3",
      path.join(bundle, "statusline/test/runtime/verify.py"),
      "--candidate",
      binary,
      "--bundle",
      bundle,
      "--expected-version",
      version,
      "--output",
      path.join(proof, "ui"),
    ],
    proof,
  );
}
async function durableJson(file: string, value: unknown) {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function seal(directory: string) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await seal(file);
    else await fs.chmod(file, (await fs.stat(file)).mode & 0o111 ? 0o555 : 0o444);
  }
  await fs.chmod(directory, 0o555);
}
export async function describeFailure(options: Options, gate: string, cause: unknown) {
  const stock = await stockVersion(options.stock).catch(() => ({
    command: options.stock,
    version: "unavailable",
  }));
  const retained = await readReady(options.root).catch(() => undefined);
  return `${gate} failed: ${cause instanceof Error ? cause.message : String(cause)}\nStock fallback: ${stock.command} (${stock.version}).\n${retained ? `Retained companion: omp-statusline (${retained.manifest.version}); bundle ${retained.bundle}.` : "Companion customization unavailable; no verified ready bundle."}\nRecovery: omp-statusline update`;
}
export async function updateCompanion(
  input: Options,
  stage: (
    options: Parameters<typeof stageOfficialBaseline>[0],
  ) => Promise<z.infer<typeof stagedSchema>> = stageOfficialBaseline,
) {
  const options = optionsSchema.parse(input);
  await fs.mkdir(options.root, { recursive: true });
  const lock = path.join(options.root, "update.lock");
  await fs.mkdir(lock).catch(() => {
    throw new Error(
      "Another companion update owns update.lock; do not remove it while that updater is running",
    );
  });
  let gate = "official updater";
  let work: string | undefined;
  try {
    await readReady(options.root);
    const stock = await stockVersion(options.stock);
    if (stock.command.startsWith(`${await fs.realpath(options.root)}${path.sep}`))
      throw new Error("Stock must not be a companion artifact");
    // The official updater resolves its replacement target from PATH, not process.execPath.
    const updaterPath = `${path.dirname(path.resolve(options.stock))}${path.delimiter}${process.env.PATH ?? ""}`;
    const selected = Bun.which("omp", { PATH: updaterPath });
    if (!selected || (await fs.realpath(selected)) !== stock.command)
      throw new Error(
        "Selected stock must resolve as omp in its invocation directory; refusing an ambiguous update target",
      );
    await run([stock.command, "update"], process.cwd(), { ...process.env, PATH: updaterPath });
    const updated = await stockVersion(options.stock);
    gate = "exact source lookup / locked official compilation";
    work = await fs.mkdtemp(path.join(options.root, "work-"));
    const baseline = stagedSchema.parse(
      await stage({ version: updated.version, stagingRoot: work, repository: options.repository }),
    );
    const bundle = path.join(options.root, `bundle-${randomUUID()}`);
    await fs.mkdir(bundle);
    await copyAssets(options.assets, bundle);
    const binary = path.join(bundle, "omp");
    await fs.copyFile(baseline.binary, binary);
    await fs.chmod(binary, 0o755);
    gate = "official API semantic verification";
    let patch = "none: semantically verified official API";
    const officialProof = path.join(work, "official-proof");
    await fs.mkdir(officialProof);
    try {
      await semanticGate(binary, bundle, baseline.binary, updated.version, officialProof);
    } catch (officialFailure) {
      await Bun.write(path.join(work, "official-api-rejection.txt"), String(officialFailure));
      gate = "minimal patch application";
      const patchFile = path.join(bundle, "statusline/core.patch");
      await run(["git", "apply", "--check", patchFile], path.join(baseline.candidate, "source"));
      await run(["git", "apply", patchFile], path.join(baseline.candidate, "source"));
      patch = await checksum(patchFile);
      gate = "candidate compilation / worker smoke";
      await buildBaselineBinary(path.join(baseline.candidate, "source"), bundle, updated.version);
      gate = "status-line runtime smoke";
      const proof = path.join(work, "patched-proof");
      await fs.mkdir(proof);
      await semanticGate(binary, bundle, baseline.binary, updated.version, proof);
    }
    gate = "whole bundle immutability";
    const workers = await verifyBaselineBinary(binary, updated.version, work);
    const files = await inventory(bundle);
    const manifest = manifestSchema.parse({
      version: updated.version,
      source: baseline.revision,
      patch,
      files,
    });
    await durableJson(path.join(bundle, "manifest.json"), manifest);
    await seal(bundle);
    const reference = {
      bundle: path.basename(bundle),
      sha256: await checksum(path.join(bundle, "manifest.json")),
    };
    const temporary = path.join(options.root, `ready-${randomUUID()}.json`);
    await durableJson(temporary, reference);
    gate = "atomic ready promotion";
    await fs.rename(temporary, path.join(options.root, "ready.json"));
    return { bundle, manifest, workers, proof: work, official: updated, provenance: baseline };
  } catch (cause) {
    throw new Error(await describeFailure(options, gate, cause), { cause });
  } finally {
    await fs
      .rmdir(lock)
      .catch((error) =>
        console.error(
          `Companion update lock cleanup failed: ${String(error)}; inspect ${lock} before another update.`,
        ),
      );
  }
}
export async function launchCompanion(options: Options, args: string[]) {
  const ready = await readReady(options.root);
  if (!ready)
    throw new Error(await describeFailure(options, "companion launch", "no ready reference"));
  const stock = await stockVersion(options.stock);
  if (stock.version !== ready.manifest.version)
    console.error(
      `Version drift: omp-statusline (${ready.manifest.version}); stock ${stock.command} (${stock.version}). Run omp-statusline update.`,
    );
  const binary = path.join(ready.bundle, "omp");
  if (typeof process.execve !== "function")
    throw new Error("omp-statusline requires Bun with process.execve support");
  // Replace this process: the existing terminal, process group, signals and exit status belong to OMP.
  process.execve(
    binary,
    [
      binary,
      ...args,
      "--config",
      path.join(ready.bundle, "statusline/overlay.json"),
      "-e",
      path.join(ready.bundle, "statusline/src/extension.ts"),
    ],
    process.env,
  );
}
