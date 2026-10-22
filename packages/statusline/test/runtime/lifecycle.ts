#!/usr/bin/env bun
/** Explicit expensive lifecycle proof; every successful promotion runs the production compiled API + UI gates. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildBaselineBinary, checksum } from "../../src/baseline";
import { readReady, updateCompanion } from "../../src/lifecycle";

const [realReport, output, fixtureReport] = process.argv.slice(2);
if (!realReport || !output)
  throw new Error(
    "Usage: bun test/runtime/lifecycle.ts <real-pipeline-result.json> <new-owned-proof-directory>",
  );
const real = await Bun.file(realReport).json();
const root = path.resolve(output);
await fs.mkdir(root);
const assets = path.resolve(import.meta.dir, "../..");
const results: { name: string; pass: boolean; details: unknown }[] = [];
function check(name: string, condition: boolean, details: unknown = null) {
  results.push({ name, pass: condition, details });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(details)}`);
}
async function command(args: string[], cwd = root) {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  await Bun.write(
    path.join(root, `command-${results.length}-${Date.now()}.json`),
    JSON.stringify({ args, cwd, exit, stdout, stderr }),
  );
  if (exit) throw new Error(`${args.join(" ")}: ${exit}\n${stderr}`);
  return stdout.trim();
}
const sourceBase = path.join(real.provenance.candidate, "source");
const fixtures = new Map<
  string,
  { source: string; binary: string; revision: string; version: string }
>();
if (fixtureReport) {
  const saved = z
    .object({
      controlledFutureFixtures: z.array(
        z.tuple([
          z.string(),
          z.object({
            source: z.string(),
            binary: z.string(),
            revision: z.string(),
            version: z.literal("18.12.7"),
          }),
        ]),
      ),
    })
    .parse(await Bun.file(fixtureReport).json());
  for (const [name, fixture] of saved.controlledFutureFixtures) fixtures.set(name, fixture);
}
for (const kind of fixtureReport ? [] : ["plain", "equivalent", "wrong-budget", "omitted-quota"]) {
  const source = path.join(root, kind + "-source");
  await fs.mkdir(source);
  await command(
    [
      "sh",
      "-c",
      'git archive 45c35e40c46166dc726ccc52f5d27f40f2449f99 | tar -x -C "$1"',
      "sh",
      source,
    ],
    sourceBase,
  );
  await command(["bun", "install", "--frozen-lockfile"], source);
  await fs.cp(
    path.join(sourceBase, "packages/natives/native"),
    path.join(source, "packages/natives/native"),
    { recursive: true, dereference: true },
  );
  if (kind !== "plain") await command(["git", "apply", path.join(assets, "core.patch")], source);
  for (const name of ["coding-agent", "utils"]) {
    const manifest = path.join(source, "packages", name, "package.json");
    const json = await Bun.file(manifest).json();
    json.version = "18.12.7";
    await Bun.write(manifest, JSON.stringify(json));
  }
  if (kind === "wrong-budget") {
    const file = path.join(source, "packages/coding-agent/src/session/context-usage-runtime.ts");
    const text = await Bun.file(file).text();
    check(
      "mutation target exists",
      text.includes('return { status: "enabled", thresholdTokens };'),
    );
    await Bun.write(
      file,
      text.replace(
        'return { status: "enabled", thresholdTokens };',
        'return { status: "enabled", thresholdTokens: contextWindow };',
      ),
    );
  }
  if (kind === "omitted-quota") {
    const file = path.join(
      source,
      "packages/coding-agent/src/modes/controllers/extension-ui-controller.ts",
    );
    const text = await Bun.file(file).text();
    check(
      "quota mutation target exists",
      text.includes("quota: this.ctx.statusLine.getQuotaSnapshot(this.ctx.session),"),
    );
    await Bun.write(
      file,
      text.replaceAll(
        "quota: this.ctx.statusLine.getQuotaSnapshot(this.ctx.session),",
        'quota: { status: "unavailable" as const },',
      ),
    );
  }
  await command(["git", "init"], source);
  await command(["git", "add", "."], source);
  await command(
    [
      "git",
      "-c",
      "user.name=Owned Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      `controlled future release ${kind}`,
    ],
    source,
  );
  const revision = await command(["git", "rev-parse", "HEAD"], source);
  const binaryRoot = path.join(root, kind + "-binary");
  await fs.mkdir(binaryRoot);
  const compiled = await buildBaselineBinary(source, binaryRoot, "18.12.7");
  fixtures.set(kind, { source, binary: compiled.binary, revision, version: "18.12.7" });
}
const fixtureSchema = (kind: string) => {
  const result = fixtures.get(kind);
  if (!result) throw new Error(kind);
  return result;
};
const stock = path.join(root, "stock-bin/omp");
const stockBinary = path.join(root, "official-owned-copy");
await fs.mkdir(path.dirname(stock));
await fs.copyFile(real.provenance.binary, stockBinary);
await fs.chmod(stockBinary, 0o755);
const channel = path.join(root, "channel");
await Bun.write(channel, fixtureSchema("plain").binary);
await Bun.write(
  stock,
  `#!/bin/sh\nif [ "$1" = update ]; then if [ -f '${root}/updater-fails' ]; then exit 31; fi; cp "$(cat '${channel}')" '${stockBinary}.new' && chmod 755 '${stockBinary}.new' && mv '${stockBinary}.new' '${stockBinary}'; exit $?; fi\nexec '${stockBinary}' "$@"\n`,
);
await fs.chmod(stock, 0o755);
const state = real.bundle.slice(0, real.bundle.lastIndexOf("/"));
const options = { stock, root: state, assets };
const previous = await fs.readFile(path.join(state, "ready.json"), "utf8");
const retained = await readReady(state);
if (!retained) throw new Error("real bootstrap missing");
const before = retained.manifest;
const home = path.join(root, "witness-home");
await fs.mkdir(home);
const witnessConfig = path.join(root, "witness.json");
await Bun.write(
  witnessConfig,
  JSON.stringify({ startup: { setupWizard: false, checkUpdate: false, quiet: true } }),
);
const witness = Bun.spawn(
  [
    path.join(retained.bundle, "omp"),
    "--mode",
    "rpc",
    "--no-ui",
    "--no-extensions",
    "-e",
    path.join(retained.bundle, "statusline/test/api-runtime/reader.ts"),
    "--model",
    "statusline-owned-fixture/model-one",
    "--no-skills",
    "--no-rules",
    "--no-lsp",
    "--config",
    witnessConfig,
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: path.join(home, "agent"),
      METRICS_UNUSED: "1",
      METRICS_EVIDENCE: path.join(root, "witness-metrics.jsonl"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const reader = witness.stdout.getReader();
let pending = "";
let witnessSession: string | undefined;
const responseSchema = z.object({
  id: z.string(),
  type: z.literal("response"),
  command: z.literal("get_state"),
  success: z.literal(true),
  data: z.object({ sessionId: z.string() }).passthrough(),
});
async function alive(label: string) {
  const id = `witness-${results.length}`;
  witness.stdin.write(JSON.stringify({ id, type: "get_state" }) + "\n");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const line of pending.split("\n").slice(0, -1)) {
      const response = responseSchema.safeParse(JSON.parse(line));
      if (response.success && response.data.id === id) {
        witnessSession ??= response.data.data.sessionId;
        check(label, witness.exitCode === null && response.data.data.sessionId === witnessSession, {
          pid: witness.pid,
          id,
          state: response.data.data,
        });
        pending = "";
        return;
      }
    }
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(20000).then(() => {
        throw new Error("witness timeout");
      }),
    ]);
    if (chunk.done) throw new Error("witness exited");
    const text = new TextDecoder().decode(chunk.value);
    pending += text;
    await fs.appendFile(path.join(root, "witness-output.jsonl"), text);
  }
  throw new Error("witness timeout");
}
async function stage(kind: string, stagingRoot: string) {
  const fixture = fixtureSchema(kind);
  const candidate = path.join(stagingRoot, "controlled-stage");
  await fs.mkdir(candidate);
  await fs.cp(fixture.source, path.join(candidate, "source"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  return { ...fixture, candidate };
}
async function launch(options: { stock: string; root: string }, args: string[]) {
  const child = Bun.spawn(["bun", path.join(assets, "bin/omp-statusline"), ...args], {
    env: { ...process.env, OMP_STATUSLINE_STOCK: options.stock, OMP_STATUSLINE_ROOT: options.root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`${stderr}\n${stdout}`);
  return exit;
}
let completed = false;
try {
  await alive("owned retained companion running before update");
  // A real controlled future source + compiled official binary; only registry/native preparation is supplied by this fixture adapter.
  const advanced = await updateCompanion(options, async ({ stagingRoot }) =>
    stage("plain", stagingRoot),
  );
  check(
    "UPDATE01 future minimal-delta promotion",
    advanced.manifest.version === "18.12.7" && !advanced.manifest.patch.startsWith("none"),
    advanced,
  );
  await alive("UPDATE01 older session survives promotion");
  check("UPDATE01 exact complete bundle launch", (await launch(options, ["--version"])) === 0);
  await Bun.write(path.join(state, "ready.json"), previous);
  await fs.copyFile(real.provenance.binary, stockBinary);
  await command([stock, "update"]);
  check(
    "UPDATE02 ordinary stock updater succeeds independently",
    (await command([stock, "--version"])) === "omp/18.12.7",
  );
  // CLI drift is exercised below in the owned environment, never the human defaults.
  const drift = Bun.spawn(["bun", path.join(assets, "bin/omp-statusline"), "--version"], {
    env: { ...process.env, OMP_STATUSLINE_STOCK: stock, OMP_STATUSLINE_ROOT: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [driftOut, driftErr, driftExit] = await Promise.all([
    new Response(drift.stdout).text(),
    new Response(drift.stderr).text(),
    drift.exited,
  ]);
  check(
    "UPDATE02 identifies actual old companion and new stock",
    driftExit === 0 &&
      driftOut.includes("18.12.6") &&
      driftErr.includes("18.12.7") &&
      driftErr.includes("omp-statusline update"),
    { driftOut, driftErr, driftExit },
  );
  check(
    "UPDATE02 independent stock advance keeps ready",
    (await fs.readFile(path.join(state, "ready.json"), "utf8")) === previous,
  );
  await alive("UPDATE02 older session survives independent stock update");
  for (const defect of ["wrong-budget", "omitted-quota"]) {
    let report = "";
    try {
      await updateCompanion(options, async ({ stagingRoot }) => stage(defect, stagingRoot));
    } catch (e) {
      report = String(e);
    }
    check(
      `UPDATE06 ${defect} rejected`,
      report.includes("failed") && report.includes("18.12.6") && report.includes("18.12.7"),
      report,
    );
    check(
      `UPDATE06 ${defect} whole retained reference`,
      (await fs.readFile(path.join(state, "ready.json"), "utf8")) === previous,
    );
    check(
      `UPDATE06 ${defect} retained assets`,
      JSON.stringify((await readReady(state))?.manifest) === JSON.stringify(before),
    );
    await alive(`UPDATE06 ${defect} running witness retained`);
  }
  const retired = await updateCompanion(options, async ({ stagingRoot }) =>
    stage("equivalent", stagingRoot),
  );
  check(
    "UPDATE05 equivalent actual compiled API retires conflicting patch",
    retired.manifest.patch.startsWith("none"),
    retired,
  );
  await alive("UPDATE05 owned older session survives patch retirement");
  await Bun.write(path.join(state, "ready.json"), previous);
  for (const bootstrap of [false, true]) {
    const failureOptions = {
      ...options,
      root: bootstrap ? path.join(root, "bootstrap-failures") : state,
    };
    for (const failure of ["updater", "source", "patch", "compilation", "workers", "runtime"]) {
      if (bootstrap && failure === "updater") continue;
      const changed = path.join(root, `assets-${bootstrap}-${failure}`);
      await fs.cp(assets, changed, {
        recursive: true,
        dereference: true,
        filter: (s) => !s.includes("node_modules"),
      });
      await fs.mkdir(path.join(changed, "node_modules"));
      await fs.cp(
        await fs.realpath(path.join(assets, "node_modules/zod")),
        path.join(changed, "node_modules/zod"),
        { recursive: true, dereference: true },
      );
      await fs.mkdir(path.join(root, "editor"), { recursive: true });
      await fs.cp(path.resolve(assets, "../editor/src"), path.join(root, "editor/src"), {
        recursive: true,
        dereference: true,
      });
      await Bun.write(
        path.join(changed, "src/extension.ts"),
        (await Bun.file(path.join(changed, "src/extension.ts")).text()) +
          `\n// changed candidate ${bootstrap} ${failure}\n`,
      );
      await Bun.write(
        path.join(changed, "overlay.json"),
        JSON.stringify({
          ...(await Bun.file(path.join(changed, "overlay.json")).json()),
          autoTitle: false,
        }),
      );
      if (failure === "updater") await Bun.write(path.join(root, "updater-fails"), "yes");
      let report = "";
      try {
        await updateCompanion({ ...failureOptions, assets: changed }, async ({ stagingRoot }) => {
          if (failure === "source") throw new Error("exact source lookup fixture failure");
          const staged = await stage(failure === "patch" ? "equivalent" : "plain", stagingRoot);
          if (failure === "patch") staged.binary = fixtureSchema("plain").binary;
          if (failure === "compilation")
            await Bun.write(
              path.join(staged.candidate, "source/scripts/ci-release-build-binaries.ts"),
              "process.exit(29);",
            );
          if (failure === "workers")
            await Bun.write(
              path.join(staged.candidate, "source/scripts/ci-release-build-binaries.ts"),
              `await Bun.write('packages/coding-agent/binaries/omp-linux-x64', '#!/bin/sh\\nif [ "$1" = --version ]; then echo omp/18.12.7; else exit 23; fi\\n');`,
            );
          if (failure === "runtime") {
            const file = path.join(changed, "src/rails.ts");
            await Bun.write(
              file,
              (await Bun.file(file).text()).replace(
                '["Week", metrics.quota.sevenDay]',
                '["Missing", metrics.quota.sevenDay]',
              ),
            );
          }
          return staged;
        });
      } catch (e) {
        report = String(e);
      }
      await fs.rm(path.join(root, "updater-fails"), { force: true });
      check(
        `${bootstrap ? "UPDATE04" : "UPDATE03"} ${failure} unsuccessful report`,
        report.includes("failed") &&
          report.includes(stock) &&
          report.includes("18.12.7") &&
          report.includes("omp-statusline update"),
        report,
      );
      if (bootstrap) {
        check(`UPDATE04 ${failure} no ready`, (await readReady(failureOptions.root)) === undefined);
        let launchError = "";
        try {
          await launch(failureOptions, ["--version"]);
        } catch (e) {
          launchError = String(e);
        }
        check(
          `UPDATE04 ${failure} explicit stock recovery`,
          launchError.includes("Companion customization unavailable") &&
            launchError.includes("omp-statusline update") &&
            launchError.includes(stock),
          launchError,
        );
      } else {
        check(
          `UPDATE03 ${failure} whole retained bundle`,
          (await fs.readFile(path.join(state, "ready.json"), "utf8")) === previous &&
            JSON.stringify((await readReady(state))?.manifest) === JSON.stringify(before),
        );
        check(`UPDATE03 ${failure} retained launch`, (await launch(options, ["--version"])) === 0);
      }
      await alive(`${bootstrap ? "UPDATE04" : "UPDATE03"} ${failure} witness survives`);
    }
  }
  check(
    "stock is owned official fixture copy",
    (await checksum(stockBinary)) === (await checksum(fixtureSchema("plain").binary)),
  );
  completed = true;
} finally {
  witness.stdin.end();
  await witness.exited;
  await Bun.write(path.join(root, "witness.stderr"), await new Response(witness.stderr).text());
  await Bun.write(
    path.join(root, "result.json"),
    JSON.stringify(
      {
        status: completed && results.every((r) => r.pass) ? "passed" : "failed",
        results,
        realOfficialSource: real.provenance.revision,
        controlledFutureFixtures: [...fixtures],
        disclosure:
          "18.12.7 fixtures are locally compiled controlled source releases, not published upstream. The fixture stage adapter replaces registry/native preparation only; promotion, patching, compilation, worker, API, UI and launch paths are production functions.",
        witness: { pid: witness.pid, exit: witness.exitCode },
      },
      null,
      2,
    ),
  );
}
