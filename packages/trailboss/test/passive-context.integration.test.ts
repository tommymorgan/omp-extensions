import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Other workspace tests mock SDK modules process-wide. Never import the runtime
// here: a fresh executable must load the real SDK and actual Trailboss package.
for (const order of ["producer-first", "trailboss-first"] as const) {
  test(`real SDK passive context: ${order}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "trailboss-runtime-"));
    const child = Bun.spawn({
      cmd: [process.execPath, new URL("./fixtures/passive-context-runtime.ts", import.meta.url).pathname, order],
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_DATA_HOME: join(home, "data"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // Failure-only subprocess watchdog, not a synchronization delay: fake time
    // cannot terminate a stuck real SDK child. Success waits only on child.exited.
    const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, output: exitCode === 0 ? "" : `${stdout}\n${stderr}` }).toEqual({ exitCode: 0, output: "" });
      expect(stdout).toContain(`PASS passive-context ${order}`);
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
  }, 50_000);
}
