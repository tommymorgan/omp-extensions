#!/usr/bin/env python3
"""Owned offline semantic gate for candidate updates and official-API retirement.
Uses only explicitly loaded local provider/usage fixtures and fresh per-run HOME.
No installation, discovery, updater, real credentials, or human sessions.
"""
import argparse, errno, fcntl, hashlib, json, os, pathlib, pty, select, struct, subprocess, termios, time

parser = argparse.ArgumentParser()
parser.add_argument('--candidate', required=True)
parser.add_argument('--baseline', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--expected-version', default='18.12.6')
args = parser.parse_args()
root = pathlib.Path(args.output).resolve()
root.mkdir(parents=True, exist_ok=False)
fixture = pathlib.Path(__file__).with_name('reader.ts').resolve()
checks = []
config = root / 'isolated.json'
config.write_text(json.dumps({'startup': {'setupWizard': False, 'checkUpdate': False, 'quiet': True}, 'git': {'enabled': False}, 'compaction': {'thresholdTokens': 300000, 'thresholdPercent': -1}}))
common = ['--no-extensions', '-e', str(fixture), '--no-skills', '--no-rules', '--no-lsp', '--no-title', '--no-session', '--auto-approve', '--model', 'statusline-owned-fixture/model-one', '--config', str(config), '--tools', 'fixture_wait']

def environment(label, fast=True, unused=False):
    home = root / (label + '-home')
    home.mkdir()
    result = {'PATH': os.environ['PATH'], 'HOME': str(home), 'PI_CODING_AGENT_DIR': str(home / 'agent'), 'XDG_CACHE_HOME': str(home / 'cache'), 'XDG_DATA_HOME': str(home / 'data'), 'XDG_STATE_HOME': str(home / 'state'), 'DO_NOT_TRACK': '1', 'TERM': 'xterm-256color', 'METRICS_EVIDENCE': str(root / (label + '.jsonl'))}
    if fast: result['METRICS_FAST'] = '1'
    if unused: result['METRICS_UNUSED'] = '1'
    return result

def rows(label):
    path = root / (label + '.jsonl')
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

def record(label, command, status):
    checks.append({'label': label, 'command': command, 'exit': status})
    (root / 'checks.json').write_text(json.dumps(checks, indent=2))
    assert status == 0, (label, status)

def run(label, binary, options, fast=True, unused=False):
    command = [binary, *options]
    result = subprocess.run(command, cwd=root, env=environment(label, fast, unused), capture_output=True, timeout=120)
    (root / (label + '.stdout')).write_bytes(result.stdout)
    (root / (label + '.stderr')).write_bytes(result.stderr)
    record(label, command, result.returncode)
    return result

class Terminal:
    def __init__(self, label, binary, fast=True, unused=False):
        self.label, self.raw = label, bytearray()
        master, slave = pty.openpty()
        self.master = master
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 96, 0, 0))
        def controlling_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.command = [binary, *common]
        self.proc = subprocess.Popen(self.command, cwd=root, env=environment(label, fast, unused), stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_tty, close_fds=True)
        os.close(slave)
    def drain(self, duration):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], min(.05, max(0, deadline-time.monotonic())))[0]:
                try: self.raw.extend(os.read(self.master, 65536))
                except OSError as error:
                    if error.errno == errno.EIO: return
                    raise
    def until(self, label, count=1, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain(.1)
            found = [row for row in rows(self.label) if row.get('label') == label]
            if len(found) >= count: return found[-1]
            assert self.proc.poll() is None, (self.label, self.proc.returncode, bytes(self.raw[-3000:]))
        raise TimeoutError((self.label, label, bytes(self.raw[-3000:])))
    def send(self, text): os.write(self.master, (text+'\r').encode())
    def close(self):
        self.send('/metrics-exit')
        self.drain(2)
        if self.proc.poll() is None:
            os.write(self.master, b'\x03\x03')
            self.drain(2)
        if self.proc.poll() is None: self.proc.terminate()
        status = self.proc.wait(timeout=15)
        os.close(self.master)
        (root / (self.label+'.pty')).write_bytes(self.raw)
        record(self.label, self.command, status)

for label, option, marker in [('version', '--version', ('omp/'+args.expected_version).encode()), ('worker-smoke', '--smoke-test', b'smoke-test: ok')]:
    result = run(label, args.candidate, [option])
    assert marker in result.stdout

policies = [
    ('fixed', {'thresholdTokens': 300000, 'thresholdPercent': -1}, 'model-one', {'status':'enabled','thresholdTokens':300000}),
    ('percent', {'thresholdTokens': -1, 'thresholdPercent': 80, 'reserveTokens':20000}, 'model-one', {'status':'enabled','thresholdTokens':400000}),
    ('model-base', {'thresholdPercent':80,'modelThresholds':{'statusline-owned-fixture/model-one':300000}}, 'model-one', {'status':'enabled','thresholdTokens':240000}),
    ('model-fixed', {'modelThresholds':{'statusline-owned-fixture/model-one':'f230000'}}, 'model-one', {'status':'enabled','thresholdTokens':230000}),
    ('disabled', {'enabled':False}, 'model-one', {'status':'disabled'}),
    ('unavailable', {}, 'no-window', {'status':'unavailable'}),
]
for label, policy, model, expected in policies:
    overlay = root / (label+'.json')
    overlay.write_text(json.dumps({'compaction':policy}))
    label = 'budget-'+label
    run(label, args.candidate, [*common, '--config', str(overlay), '--model','statusline-owned-fixture/'+model, '-p','/metrics-probe'])
    observation = next(row for row in rows(label) if row['label']=='probe')
    assert observation['metrics']['compaction'] == expected, observation
    assert observation['calls']==0 and observation['fetches']==0 and observation['readFetches']==0

# Actual streaming and native quota collection through the compiled interactive host.
terminal = Terminal('tui-semantic', args.candidate, fast=False)
try:
    first = terminal.until('session_start')
    assert first['metrics']['generationRate']=={'status':'unavailable'}
    terminal.drain(1)
    terminal.send('/metrics-probe')
    quota = terminal.until('probe')['metrics']['quota']
    assert quota['status']=='available', quota
    assert abs(quota['sevenDay']['remainingFraction']-.41)<1e-12
    assert quota['sevenDay']['resetsAt']==1900000000123
    assert quota['fiveHour']=={'remainingFraction':1,'resetsAt':1899999900123}
    terminal.send('hello-owned')
    terminal.until('agent_end')
    samples = rows('tui-semantic')
    assert any(row.get('label')=='message_update' and row['metrics']['generationRate']['status']=='available' for row in samples)
    tool = [row for row in samples if row.get('label') in ['tool-before','tool-during']]
    assert len(tool)==2 and tool[0]['metrics']['generationRate']['status']=='available'
    assert tool[0]['metrics']['generationRate']==tool[1]['metrics']['generationRate']
    terminal.send('/metrics-model')
    terminal.until('model-switch')
    terminal.drain(.5)
    terminal.send('/metrics-probe')
    assert terminal.until('probe',count=2)['metrics']['quota']=={'status':'unavailable'}
finally: terminal.close()

# Reader-only paths never create another usage cadence, and do not perform model work.
assert all(row.get('readFetches',0)==0 for row in rows('tui-semantic'))
assert len([row for row in rows('tui-semantic') if row['label']=='native-usage-fetch'])==1

# Independent account invalidation begins from an available snapshot (not an already-invalid model).
terminal = Terminal('tui-account-scope', args.candidate)
try:
    terminal.until('session_start')
    terminal.drain(1)
    terminal.send('/metrics-probe')
    assert terminal.until('probe')['metrics']['quota']['status']=='available'
    terminal.send('/metrics-account')
    assert terminal.until('account-switch')['metrics']['quota']=={'status':'unavailable'}
finally: terminal.close()
assert all(row.get('readFetches',0)==0 for row in rows('tui-account-scope'))

def messages(label):
    result=[]
    for row in rows(label):
        if row['label']!='message-evidence': continue
        message=row['event']['message']
        result.append({key:message.get(key) for key in ['role','content','stopReason','usage']})
    return result

# Ordinary print and TUI paths, with metrics API deliberately unused.
for name, binary in [('baseline',args.baseline),('candidate',args.candidate)]:
    run(name+'-print-unused',binary,[*common,'-p','hello-owned'],unused=True)
    terminal=Terminal(name+'-tui-unused',binary,unused=True)
    try:
        terminal.until('session_start')
        terminal.send('hello-owned')
        terminal.until('agent_end')
    finally: terminal.close()
for mode in ['print','tui']:
    assert messages('baseline-'+mode+'-unused')==messages('candidate-'+mode+'-unused'),mode
    assert all(row.get('metrics') is None for row in rows('candidate-'+mode+'-unused'))
assert (root/'baseline-print-unused.stdout').read_bytes()==(root/'candidate-print-unused.stdout').read_bytes()

# The real JSON-lines RPC host, not a source-text or method-name probe.
for name,binary in [('baseline',args.baseline),('candidate',args.candidate)]:
    label=name+'-rpc-unused'
    command=[binary,*common,'--mode','rpc','--no-ui']
    proc=subprocess.Popen(command,cwd=root,env=environment(label,unused=True),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    proc.stdin.write((json.dumps({'id':'owned-prompt','type':'prompt','message':'hello-owned'})+'\n').encode());proc.stdin.flush()
    raw=bytearray(); pending=b''; events=[]; deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        if select.select([proc.stdout],[],[],.1)[0]:
            chunk=os.read(proc.stdout.fileno(),65536)
            if not chunk: break
            raw.extend(chunk);pending+=chunk
            while b'\n' in pending:
                line,pending=pending.split(b'\n',1)
                if line.strip():events.append(json.loads(line))
        if any(event.get('type')=='agent_end' for event in events): break
    assert any(event.get('type')=='agent_end' for event in events),events
    proc.stdin.close(); status=proc.wait(timeout=15)
    (root/(label+'.stdout')).write_bytes(raw)
    (root/(label+'.stderr')).write_bytes(proc.stderr.read())
    record(label,command,status)
assert messages('baseline-rpc-unused')==messages('candidate-rpc-unused')
assert all(row.get('metrics') is None for row in rows('candidate-rpc-unused'))

report={'status':'passed','candidate':args.candidate,'candidateSha256':hashlib.file_digest(open(args.candidate,'rb'),'sha256').hexdigest(),'baseline':args.baseline,'checks':checks,'semantics':['API01 four central policy variants without model work','API02 disabled and unavailable','API03 actual streaming, billed completion and tool-time hold; session equality separately covered by package integration test','API04 baseline/candidate print, real TUI and RPC response equivalence with metrics unused','API05 native selected weekly and five-hour cache, exact resets, account/model invalidation and zero read-triggered fetches'],'limits':['Synthetic provider/account data only; no real credentials or provider traffic','Ordinary mode comparisons use an under-threshold fixture, so neither version auto-compacts','Native meter exact instantaneous equality is additionally asserted in the real AgentSession package integration test; no private meter access from the extension']}
(root/'result.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
