import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import { z } from "zod";

const officialRepository = "https://github.com/can1357/oh-my-pi.git";
const releaseSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const manifestSchema = z.object({ version: releaseSchema });
const sourceSchema = z.object({
  version: releaseSchema,
  revision: revisionSchema,
  repository: z.string().min(1),
  tag: z.string(),
});
const nativeSchema = z.object({
  version: releaseSchema,
  dist: z.object({ tarball: z.url(), integrity: z.string().regex(/^sha512-[A-Za-z0-9+/=]+$/) }),
});

async function command(gate: string, args: string[], cwd: string, env = process.env) {
  try {
    const result = await exec(args, { cwd, env, timeout: 1_800_000 });
    return result.stdout.trim();
  } catch (cause) {
    throw new Error(`${gate} failed: ${args.join(" ")}`, { cause });
  }
}

/** Resolve only the selected release tag, never a moving default branch. Repository override supports owned offline mirrors. */
export async function resolveOfficialSource(version: string, repository = officialRepository) {
  releaseSchema.parse(version);
  const tag = `refs/tags/v${version}`;
  const output = await command(
    "immutable source mapping",
    ["git", "ls-remote", repository, tag, `${tag}^{}`],
    process.cwd(),
  );
  const refs = output.split("\n").map((line) => line.split(/\s+/));
  const revision =
    refs.find((row) => row[1] === `${tag}^{}`)?.[0] ?? refs.find((row) => row[1] === tag)?.[0];
  if (!revision) throw new Error(`No immutable source mapping for official release ${version}`);
  return sourceSchema.parse({ version, revision, repository, tag });
}

export async function checksum(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** Checkout into a new owned directory; neither caller source trees nor existing candidates are reused or modified. */
export async function checkoutOfficialSource(
  source: z.infer<typeof sourceSchema>,
  directory: string,
) {
  source = sourceSchema.parse(source);
  await command(
    "source checkout",
    [
      "git",
      "clone",
      "--no-checkout",
      "--depth",
      "1",
      "--branch",
      `v${source.version}`,
      source.repository,
      directory,
    ],
    process.cwd(),
  );
  const revision = await command("source revision", ["git", "rev-parse", "HEAD"], directory);
  if (revision !== source.revision)
    throw new Error(`Source mapping changed: expected ${source.revision}, received ${revision}`);
  await command("source checkout", ["git", "checkout", "--detach", source.revision], directory);
  const manifest = manifestSchema.parse(
    await Bun.file(path.join(directory, "packages/coding-agent/package.json")).json(),
  );
  if (manifest.version !== source.version)
    throw new Error(
      `Source release mismatch: selected ${source.version}, declared ${manifest.version}`,
    );
  return { ...source, lockChecksum: await checksum(path.join(directory, "bun.lock")) };
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Source dependency fetch failed: ${url}: HTTP ${response.status}`);
  return response.json();
}

/** Use the exact published native leaf, authenticated by registry integrity and the official builder's version-stamp gate. */
async function prepareNative(sourceDirectory: string, version: string, revision: string) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Unsupported baseline build target: requires linux-x64");
  const name = "@oh-my-pi/pi-natives-linux-x64";
  const metadata = nativeSchema.parse(
    await fetchJson(`https://registry.npmjs.org/${name}/${version}`),
  );
  if (metadata.version !== version)
    throw new Error(`Native release mismatch: ${metadata.version} != ${version}`);
  const attestations = z
    .object({
      attestations: z.array(
        z.object({
          predicateType: z.string(),
          bundle: z.object({ dsseEnvelope: z.object({ payload: z.string() }) }),
        }),
      ),
    })
    .parse(
      await fetchJson(
        `https://registry.npmjs.org/-/npm/v1/attestations/@oh-my-pi%2fpi-natives-linux-x64@${version}`,
      ),
    );
  const attestation = attestations.attestations.find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
  );
  if (!attestation) throw new Error("Native release has no source provenance");
  const statement = z
    .object({
      subject: z.array(z.object({ digest: z.object({ sha512: z.string() }) })),
      predicate: z.object({
        buildDefinition: z.object({
          resolvedDependencies: z.array(
            z.object({ uri: z.string(), digest: z.object({ gitCommit: z.string() }) }),
          ),
        }),
      }),
    })
    .parse(
      JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64").toString("utf8")),
    );
  const nativeSource = statement.predicate.buildDefinition.resolvedDependencies.find((entry) =>
    entry.uri.startsWith("git+https://github.com/can1357/oh-my-pi@"),
  );
  if (nativeSource?.digest.gitCommit !== revision)
    throw new Error("Native source revision mismatch");
  const expectedDigest = Buffer.from(
    metadata.dist.integrity.slice("sha512-".length),
    "base64",
  ).toString("hex");
  if (!statement.subject.some((entry) => entry.digest.sha512 === expectedDigest))
    throw new Error("Native provenance digest mismatch");
  const response = await fetch(metadata.dist.tarball);
  if (!response.ok) throw new Error(`Native archive fetch failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== metadata.dist.integrity) throw new Error("Native archive integrity mismatch");
  const archive = path.join(sourceDirectory, "native-release.tgz");
  await Bun.write(archive, bytes);
  const entries = await command(
    "native archive listing",
    ["tar", "-tzf", archive],
    sourceDirectory,
  );
  const files = entries
    .split("\n")
    .filter((entry) => /^package\/pi_natives\.linux-x64-(baseline|modern)\.node$/.test(entry));
  if (!files.length) throw new Error("Exact native release archive contains no linux-x64 addon");
  await command(
    "native archive extraction",
    [
      "tar",
      "-xzf",
      archive,
      "--strip-components=1",
      "-C",
      path.join(sourceDirectory, "packages/natives/native"),
      ...files,
    ],
    sourceDirectory,
  );
  await fs.unlink(archive);
  return {
    package: name,
    version,
    sourceRevision: revision,
    integrity,
    addons: await Promise.all(
      files.map(async (file) => ({
        file: path.basename(file),
        sha256: await checksum(
          path.join(sourceDirectory, "packages/natives/native", path.basename(file)),
        ),
      })),
    ),
  };
}

/** The private gate is also usable by later candidate builders; it never promotes a candidate. */
export async function verifyBaselineBinary(binary: string, version: string, ownedRoot: string) {
  const home = path.join(ownedRoot, "smoke-home");
  await fs.mkdir(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: path.join(home, "agent"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
  };
  const reportedVersion = await command(
    "staged version gate",
    [binary, "--version"],
    ownedRoot,
    env,
  );
  const baseVersion = reportedVersion.startsWith("omp/")
    ? reportedVersion.slice(4)
    : reportedVersion;
  if (baseVersion !== version)
    throw new Error(`Staged version mismatch: expected ${version}, received ${reportedVersion}`);
  const smoke = await command("worker smoke gate", [binary, "--smoke-test"], ownedRoot, env);
  if (!smoke.split("\n").includes("smoke-test: ok"))
    throw new Error("Worker smoke gate returned no success marker");
  return { version: baseVersion, sha256: await checksum(binary), smoke };
}

/** Compile through the selected source's supported release entry, then verify the exact copied artifact. */
export async function buildBaselineBinary(
  sourceDirectory: string,
  candidate: string,
  version: string,
) {
  await command(
    "supported binary build",
    ["bun", "run", "ci:release:build-binaries", "--targets", "linux-x64"],
    sourceDirectory,
  );
  const binary = path.join(candidate, "omp");
  await fs.copyFile(
    path.join(sourceDirectory, "packages/coding-agent/binaries/omp-linux-x64"),
    binary,
  );
  await fs.chmod(binary, 0o755);
  return { binary, ...(await verifyBaselineBinary(binary, version, candidate)) };
}

/** Build an unmodified official baseline in a new candidate root. No stock/current path, install, activation or promotion API exists. */
export async function stageOfficialBaseline(options: {
  version: string;
  stagingRoot: string;
  repository?: string;
}) {
  for (const tool of ["git", "bun", "tar"]) {
    if (!Bun.which(tool, { PATH: process.env.PATH }))
      throw new Error(`Missing required local tool: ${tool}`);
  }
  const source = await resolveOfficialSource(options.version, options.repository);
  await fs.mkdir(options.stagingRoot, { recursive: true });
  const candidate = await fs.mkdtemp(
    path.join(await fs.realpath(options.stagingRoot), "baseline-"),
  );
  try {
    const sourceDirectory = path.join(candidate, "source");
    const provenance = await checkoutOfficialSource(source, sourceDirectory);
    const rootManifest = z
      .object({
        scripts: z.object({
          "ci:release:build-binaries": z.literal("bun scripts/ci-release-build-binaries.ts"),
        }),
      })
      .parse(await Bun.file(path.join(sourceDirectory, "package.json")).json());
    void rootManifest;
    await command(
      "locked dependency preparation",
      ["bun", "install", "--frozen-lockfile"],
      sourceDirectory,
    );
    if ((await checksum(path.join(sourceDirectory, "bun.lock"))) !== provenance.lockChecksum)
      throw new Error("Locked dependency preparation changed bun.lock");
    const native = await prepareNative(sourceDirectory, source.version, source.revision);
    const verification = await buildBaselineBinary(sourceDirectory, candidate, source.version);
    const evidence = { ...provenance, native, ...verification };
    await Bun.write(
      path.join(candidate, "provenance.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    return { candidate, ...evidence };
  } catch (cause) {
    await fs.rm(candidate, { recursive: true, force: true });
    throw new Error(
      `Baseline staging failed for ${source.version}; no candidate promoted: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
