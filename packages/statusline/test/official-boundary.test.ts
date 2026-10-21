import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import { checksum, stageOfficialBaseline } from "../src/baseline";

test.skipIf(process.env.STATUSLINE_REAL_BASELINE !== "1")(
  "SRC01 real official18.12.6 compiles and passes workers without disturbing stock or an owned RPC witness",
  async () => {
    const stock = Bun.which("omp");
    if (!stock) throw new Error("Missing stock omp witness prerequisite");
    const owned = await fs.mkdtemp(path.join(os.tmpdir(), "statusline-official-proof-"));
    const home = path.join(owned, "witness-home");
    await fs.mkdir(home);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: path.join(home, "agent"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      OPENAI_API_KEY: "owned-witness-no-model-request",
    };
    const stockChecksum = await checksum(stock);
    const stockVersionOutput = (
      await exec([stock, "--version"], { cwd: owned, env })
    ).stdout.trim();
    expect(stockVersionOutput).toBe("omp/18.12.6");
    const stockVersion = stockVersionOutput.slice(4);
    const companionBefore = Bun.which("omp-statusline");
    await Bun.write(path.join(owned, "current-companion"), "retained-owned-bundle");
    const witness = Bun.spawn(
      [
        stock,
        "--mode",
        "rpc",
        "--model",
        "openai/gpt-4.1",
        "--no-session",
        "--no-extensions",
        "--no-skills",
      ],
      { cwd: owned, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const errors = new Response(witness.stderr).text();
    const reader = witness.stdout.getReader();
    const decoder = new TextDecoder();
    async function ping(id: string) {
      witness.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
      let text = "";
      const deadline = Promise.withResolvers<never>();
      const timer = setTimeout(
        () => deadline.reject(new Error("Owned RPC witness did not answer")),
        30_000,
      );
      try {
        while (!text.includes(`"id":"${id}"`)) {
          const value = await Promise.race([reader.read(), deadline.promise]);
          if (value.done) throw new Error(`Owned witness exited before response: ${await errors}`);
          text += decoder.decode(value.value);
        }
        expect(text).toContain('"success":true');
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      await ping("before");
      const pid = witness.pid;
      const result = await stageOfficialBaseline({
        version: stockVersion,
        stagingRoot: path.join(owned, "candidates"),
      });
      expect(result.revision).toBe("45c35e40c46166dc726ccc52f5d27f40f2449f99");
      expect(result.native.sourceRevision).toBe(result.revision);
      expect(result.sha256).toBe(await checksum(result.binary));
      expect(result.smoke).toContain("smoke-test: ok");
      expect(await checksum(stock)).toBe(stockChecksum);
      expect(witness.pid).toBe(pid);
      expect(witness.exitCode).toBeNull();
      await ping("after");
      expect(Bun.which("omp-statusline")).toBe(companionBefore);
      expect(await Bun.file(path.join(owned, "current-companion")).text()).toBe(
        "retained-owned-bundle",
      );
      const evidence = {
        owned,
        stock,
        stockVersion,
        stockChecksum,
        stockChecksumAfter: await checksum(stock),
        witnessPid: pid,
        witnessAnsweredBeforeAndAfter: true,
        companionCommandBefore: companionBefore,
        companionCommandAfter: Bun.which("omp-statusline"),
        ...result,
      };
      await Bun.write(path.join(owned, "boundary-proof.json"), JSON.stringify(evidence, null, 2));
      process.stdout.write(`OFFICIAL_BASELINE_PROOF ${JSON.stringify(evidence)}\n`);
    } finally {
      await reader.cancel();
      witness.stdin.end();
      if (witness.exitCode === null) witness.kill();
      await witness.exited;
      await errors;
    }
  },
  1_800_000,
);
