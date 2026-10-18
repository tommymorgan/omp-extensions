/**
 * Boundary harness for cache-watch Task 3.1 (plan contract): a pty-driven
 * OMP TUI run against a fake OpenAI-compat provider with synthetic collapsing
 * cache-read rates must show the collapse banner in the pty capture during
 * the collapse, remove it after the recovery fixture, and never show it in a
 * second, non-collapsing session's capture.
 *
 * Usage: bun packages/cache-watch/test/pty-boundary.ts
 * Scratch lives under /tmp/cache-watch-boundary (never the real ~/.omp).
 *
 * Session 1 rate script (usage fields shaped server-side; detector math needs
 * six consecutive collapsed responses for the 5-response window to fall under
 * the 70% floor, and four recovery responses for three consecutive
 * above-floor evaluations):
 *   turns 1–20  94%  (baseline)
 *   turns 21–26 58%  (collapse; banner must appear by turn 26)
 *   turns 27–31 94%  (recovery; banner must be gone by turn 31)
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeProvider } from './fake-provider.ts';

const ROOT = '/tmp/cache-watch-boundary';
const HOME = join(ROOT, 'home');
const OMP_BIN = '/home/tommy/.local/bin/omp';
const EXTENSION_SOURCE = import.meta.dir + '/../src/index.ts';
const BANNER_NEEDLE = 'prompt-cache collapse';
const TOTAL_TURNS = 31;
const COLLAPSE_START = 21;
const RECOVERY_START = 27;

interface RunResult {
  label: string;
  capture: string;
  requests: { turn: number | null; rate: number }[];
  phases: { afterCollapse: boolean; afterRecoveryTail: boolean };
}

function buildScratchHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  const agentDir = join(HOME, '.omp', 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'models.yml'),
    [
      'providers:',
      '  fakewatch:',
      '    baseUrl: http://127.0.0.1:PORT/v1',
      '    api: openai-completions',
      '    auth: none',
      '    models:',
      '      - id: fake-collapse',
      '        name: Fake Collapse Provider',
      '        input: [text]',
      '        contextWindow: 262144',
      '        maxTokens: 8192',
      '        cost:',
      '          input: 0',
      '          output: 0',
      '          cacheRead: 0',
      '          cacheWrite: 0',
      '        compat:',
      '          supportsStore: false',
      '          supportsDeveloperRole: false',
      '          supportsStrictMode: false',
      '          maxTokensField: max_tokens',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(agentDir, 'config.yml'),
    ['setupVersion: 2', 'modelRoles:', '  default: fakewatch/fake-collapse', ''].join('\n'),
  );
  const link = join(extensionsDir, 'cache-watch.ts');
  rmSync(link, { force: true });
  symlinkSync(EXTENSION_SOURCE, link);
}

function readCapture(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function waitFor(
  probe: () => boolean,
  timeoutMs: number,
  everyMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await Bun.sleep(everyMs);
  }
  return probe();
}

async function driveSession(
  label: string,
  cwd: string,
  rates: Map<number, number>,
  turns: number,
): Promise<RunResult> {
  const provider = await startFakeProvider(rates);
  buildScratchHome();
  const modelsPath = join(HOME, '.omp', 'agent', 'models.yml');
  writeFileSync(modelsPath, readFileSync(modelsPath, 'utf8').replace('PORT', String(provider.port)));
  mkdirSync(cwd, { recursive: true });
  const capture = join(ROOT, `${label}.capture`);

  const command =
    `stty rows 40 cols 120; env HOME=${HOME} TERM=xterm-256color ` +
    `${OMP_BIN} --model fakewatch/fake-collapse`;
  const proc = Bun.spawn(['script', '-qfc', command, capture], {
    cwd,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'pipe',
  });

  try {
    // Boot: dismiss the startup splash, then drive turns by polling for the
    // assistant reply marker of the previous turn.
    await Bun.sleep(6000);
    proc.stdin.write('\r');
    await Bun.sleep(1500);
    for (let turn = 1; turn <= turns; turn++) {
      const seen = await waitFor(
        () => turn === 1 || readCapture(capture).includes(`ack-${turn - 1}`),
        45_000,
      );
      if (!seen) throw new Error(`${label}: previous turn's reply never appeared (turn ${turn})`);
      proc.stdin.write(`turn ${turn}\r`);
    }
    const finished = await waitFor(() => readCapture(capture).includes(`ack-${turns}`), 45_000);
    if (!finished) throw new Error(`${label}: final turn's reply never appeared`);
    // Let the post-turn repaint land before reading the tail.
    await Bun.sleep(1500);
  } finally {
    // omp's TUI does not quit on a single Ctrl-C (it lands in the composer),
    // so waiting for a graceful exit hangs forever. Give it a short grace
    // period, then kill `script`; closing the pty master SIGHUPs omp. The
    // capture file is already complete at this point.
    proc.stdin.write('\x03');
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    if (!exited) {
      proc.kill();
      await proc.exited;
    }
    if (proc.exitCode !== 0 && proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`${label}: script exited ${proc.exitCode}: ${stderr.slice(0, 400)}`);
    }
  }

  const text = readCapture(capture);
  const tail = text.slice(-8192);
  return {
    label,
    capture: text,
    requests: provider.requests.map(r => ({ turn: r.turn, rate: r.rate })),
    phases: {
      afterCollapse: text.includes(BANNER_NEEDLE),
      afterRecoveryTail: stripAnsi(tail).includes(BANNER_NEEDLE),
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][0-9A-B]/g, '');
}

// --- Session 1: collapse then recovery -------------------------------------
const rates = new Map<number, number>();
for (let t = 1; t <= TOTAL_TURNS; t++) {
  rates.set(t, t >= RECOVERY_START ? 0.94 : t >= COLLAPSE_START ? 0.58 : 0.94);
}
const session1 = await driveSession('collapsing', join(ROOT, 'cwd-collapsing'), rates, TOTAL_TURNS);

// Banner must be present mid-capture (it appeared during turns 21–26).
const collapseEvidence = session1.phases.afterCollapse;
// Banner must be gone from the post-recovery tail.
const recoveryEvidence = !session1.phases.afterRecoveryTail;

// --- Session 2: never collapses ---------------------------------------------
const session2 = await driveSession(
  'steady',
  join(ROOT, 'cwd-steady'),
  new Map<number, number>(),
  26,
);
const steadyEvidence = !stripAnsi(session2.capture).includes(BANNER_NEEDLE);

const summary = [
  `boundary session=collapsing turns=${TOTAL_TURNS} requests=${session1.requests.length}`,
  `  banner during collapse: ${collapseEvidence ? 'PRESENT' : 'MISSING'}`,
  `  banner after recovery (capture tail): ${recoveryEvidence ? 'ABSENT' : 'STILL PRESENT'}`,
  `boundary session=steady turns=26 requests=${session2.requests.length}`,
  `  banner anywhere: ${steadyEvidence ? 'ABSENT' : 'PRESENT'}`,
  `request rates (collapsing): ${session1.requests.map(r => (r.turn === null ? '-' : `${r.turn}:${Math.round(r.rate * 100)}`)).join(' ')}`,
  `result: ${collapseEvidence && recoveryEvidence && steadyEvidence ? 'PASS' : 'FAIL'}`,
].join('\n');
writeFileSync(join(ROOT, 'evidence.txt'), summary + '\n');
console.log(summary);
process.exit(collapseEvidence && recoveryEvidence && steadyEvidence ? 0 : 1);
