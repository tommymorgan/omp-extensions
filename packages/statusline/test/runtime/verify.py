#!/usr/bin/env python3
"""Explicit offline feature gate: exact compiled candidate, real PTYs, owned profiles.
Keeps captures and observations. Never installs or starts an updater.
"""
import argparse,errno,fcntl,hashlib,json,os,pathlib,pty,select,signal,struct,subprocess,termios,time,re
p=argparse.ArgumentParser();p.add_argument('--candidate',required=True);p.add_argument('--bundle',required=True);p.add_argument('--output',required=True);p.add_argument('--expected-version',default='18.12.6');p.add_argument('--editor',default='editor/src/index.ts');p.add_argument('--baseline');a=p.parse_args()
root=pathlib.Path(a.output).resolve();root.mkdir(parents=True,exist_ok=False)
bundle=pathlib.Path(a.bundle).resolve();package=bundle/'statusline';fixture=package/'test/runtime/fixture.ts';editor=(bundle/a.editor).resolve()
assert editor.is_relative_to(bundle) and editor.is_file(),'editor must be an owned staged bundle asset'
for asset in [fixture,package/'src/extension.ts',package/'src/rails.ts',package/'overlay.json']:
 assert asset.resolve().is_relative_to(bundle) and asset.is_file(),('missing or escaping bundle asset',str(asset))
def checksum(path):
 with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
assets=[];digests={}
for path in sorted(bundle.rglob('*')):
 assert not path.is_symlink(),('mutable symlink in bundle',str(path))
 if path.is_file():
  digest=checksum(path);digests[str(path.resolve())]=digest
  assets.append({'path':str(path.relative_to(bundle)),'sha256':digest})
candidate=pathlib.Path(a.candidate).resolve()
binary_digest=digests.get(str(candidate))
if binary_digest is None:binary_digest=checksum(candidate)
(root/'bundle-assets.json').write_text(json.dumps({'bundle':str(bundle),'candidate':str(candidate),'binarySha256':binary_digest,'assets':assets},indent=2))
config=root/'fixture.json';config.write_text(json.dumps({'startup':{'setupWizard':False,'checkUpdate':False,'quiet':True},'compaction':{'thresholdTokens':300000,'thresholdPercent':-1},'autoTitle':False}))
version=subprocess.run([a.candidate,'--version'],capture_output=True,text=True,check=True);assert 'omp/'+a.expected_version in version.stdout
checks=[]
def check(name,condition,details=None):
 checks.append({'check':name,'pass':bool(condition),'details':details});(root/'checks.json').write_text(json.dumps(checks,indent=2));assert condition,(name,details)
def strip(text):return re.sub(r'\x1b\[[0-9;]*m','',text)
class Terminal:
 def __init__(self,width,case='both',vcs_kind='jj',binary=None):
  self.width=width;self.label=str(width)+('' if case=='both' else '-'+case);self.raw=bytearray();self.log=root/(self.label+'.jsonl');self.home=root/(self.label+'-home');self.home.mkdir();self.cwd=root/(self.label+'-repo');self.cwd.mkdir()
  if vcs_kind!='none':subprocess.run(['git','init','-b','fix-cache' if vcs_kind=='git' else 'main',str(self.cwd)],capture_output=True,check=True)
  if vcs_kind=='jj':
   subprocess.run(['jj','git','init','--colocate',str(self.cwd)],capture_output=True,check=True)
   subprocess.run(['jj','bookmark','create','statusline-plan'],cwd=self.cwd,capture_output=True,check=True)
  master,slave=pty.openpty();self.master=master;fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,width,0,0))
  def ctty():os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
  env={'PATH':os.environ['PATH'],'HOME':str(self.home),'PI_CODING_AGENT_DIR':str(self.home/'agent'),'XDG_CACHE_HOME':str(self.home/'cache'),'XDG_DATA_HOME':str(self.home/'data'),'XDG_STATE_HOME':str(self.home/'state'),'TERM':'xterm-256color','DO_NOT_TRACK':'1','STATUSLINE_EVIDENCE':str(self.log)}
  env['STATUSLINE_QUOTA']=case
  self.command=[binary or a.candidate,'--no-extensions','-e',str(editor),'-e',str(fixture),'--no-skills','--no-rules','--no-lsp','--no-title','--auto-approve','--model','statusline-ui-fixture/model-one','--config',str(config),'--config',str(package/'overlay.json'),'--tools','fixture_wait']
  self.proc=subprocess.Popen(self.command,cwd=self.cwd,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=ctty,close_fds=True);os.close(slave)
 def rows(self):
  # The fixture may still be appending its last JSON record; only newline-committed rows are readable.
  return [json.loads(row) for row in self.log.read_bytes().split(b'\n')[:-1]] if self.log.exists() else []
 def drain(self,seconds):
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   if select.select([self.master],[],[],min(.05,max(0,end-time.monotonic())))[0]:
    try:self.raw.extend(os.read(self.master,65536))
    except OSError as e:
     if e.errno==errno.EIO:return
     raise
 def until(self,kind,count=1,timeout=40):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   self.drain(.1);rows=[r for r in self.rows() if r.get('kind')==kind]
   if len(rows)>=count:return rows[-1]
   assert self.proc.poll() is None,(kind,self.proc.returncode,bytes(self.raw[-4000:]))
  raise TimeoutError((kind,bytes(self.raw[-5000:])))
 def send(self,text):os.write(self.master,(text+'\r').encode())
 def keys(self,data):os.write(self.master,data)
 def resize(self,width):
  self.width=width;fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',40,width,0,0));os.kill(self.proc.pid,signal.SIGWINCH)
 def rail(self,key='upper'):
  self.drain(1.2);rows=[r for r in self.rows() if r.get('kind')=='rail' and r['key'].endswith(key)];assert rows,bytes(self.raw[-4000:]);return rows[-1],strip(' '.join(rows[-1]['rows']))
 def capture(self,name):
  self.drain(.2);(root/f'{self.label}-{name}.pty').write_bytes(self.raw)
  rails=[r for r in self.rows() if r.get('kind')=='rail'][-2:];(root/f'{self.label}-{name}-rails.json').write_text(json.dumps(rails,indent=2))
 def close(self):
  self.keys(b'\x15');self.send('/fixture-exit');self.drain(2)
  if self.proc.poll() is None:self.keys(b'\x03\x03');self.drain(2)
  if self.proc.poll() is None:self.proc.terminate()
  status=self.proc.wait(timeout=15);os.close(self.master);(root/(self.label+'.pty')).write_bytes(self.raw);check(self.label+' clean exit',status==0,status)
# A phone-width ID must never force an otherwise fitting path into a narrow strip.
t=Terminal(40,vcs_kind='none')
try:
 t.until('start')
 identity='omp-0123456789abcdef01234567'
 t.send('/fixture-mail '+identity);t.until('mail-updated')
 t.keys(b'phone draft stays intact')
 for width in [40,80,40]:
  t.resize(width)
  lower,_=t.rail('lower');visible=[strip(row) for row in lower['rows']]
  check(f'phone {width} complete path and model',str(t.cwd) in strip(''.join(lower['rows'])) and any('GPT-6.1 Sol' in row for row in visible),lower)
  check(f'phone {width} complete right-aligned identity',any(row.endswith(identity) and columns==width for row,columns in zip(visible,lower['columns'])),lower)
  check(f'phone {width} bounded rows and preserved draft',all(columns<=width for columns in lower['columns']) and lower['draft']=='phone draft stays intact',lower)
  t.capture(f'phone-{width}')
finally:t.close()

for width in [80,96]:
 t=Terminal(width)
 try:
  t.until('start');t.drain(2)
  row,text=t.rail();lower,lowertext=t.rail('lower')
  title='🧭 Investigate cache accounting across the entire selected deployment boundary'
  check(f'{width} UI01/02 full user title',title in text,text)
  check(f'{width} QUOTA01 reported inline remaining',all(s in text for s in ['Week 41% left','5h 74% left','reset 5d 5h','reset 3h 12m']),text)
  check(f'{width} VCS01 jj first complete lower fields','statusline-plan' in lowertext and 'GPT-6.1 Sol' in lowertext and str(t.cwd) in strip(''.join(lower['rows'])),lowertext)
  check(f'{width} UI01 no counters or duplicate title',not any(s in text.replace(title,'')+lowertext for s in ['cache','cost','$','1000000']) and text.count(title)==1,text)
  colored=''.join(row['rows'])
  check(f'{width} UI04 semantic title cache budget allowance colors',row['palette']['accent']+title.split(' ')[0] in colored and row['palette']['success']+'💰' in colored and row['palette']['warning'] in colored and row['palette']['muted']+'Week ' in colored,row)
  check(f'{width} UI04 right edge unavailable rate',any(strip(line).endswith('— tok/s') and columns==row['width'] for line,columns in zip(row['rows'],row['columns'])),row)
  check(f'{width} UI05 absent identity omitted','✉' not in lowertext and 'work published' not in lowertext,lowertext)
  identities=['id','agent-native-fixture-0123456789abcdef-0123456789abcdef','agent-next-0123456789abcdef-0123456789abcdef']
  for index,identity in enumerate([*identities,'unassigned','clear'],1):
   t.send('/fixture-mail '+identity);published=t.until('mail-updated',index);mailrow,mailtext=t.rail('lower')
   full=strip(''.join(mailrow['rows']))
   check(f'{width} UI05 identity {index}',(identity in full if identity not in ['unassigned','clear'] else '✉' not in full) and all(old not in full for old in identities if old!=identity) and 'work published' not in full,full)
   if identity not in ['unassigned','clear']:
    check(f'{width} UI05 identity shares facts at measured right edge {index}',any(strip(line).endswith(identity) and strip(line).split('✉ ')[0].strip(' ·') and columns==mailrow['width'] for line,columns in zip(mailrow['rows'],mailrow['columns'])),mailrow)
   if identity=='id' and len(str(t.cwd))+len('▰   ·  ⎇ statusline-plan  ·  ✉ id')<=width:
    check(f'{width} UI05 fitting directory bookmark and ID share physical row',any(str(t.cwd) in strip(line) and 'statusline-plan' in strip(line) and strip(line).endswith(identity) for line in mailrow['rows']),mailrow)
   check(f'{width} UI05 full facts retained {index}',str(t.cwd) in full and 'statusline-plan' in full and 'GPT-6.1 Sol' in full and all(c<=mailrow['width'] for c in mailrow['columns']),mailrow)
   check(f'{width} UI05 status read adds no provider traffic {index}',published['calls']==mailrow['calls'] and published['quotaFetches']==mailrow['quotaFetches'],mailrow)
  long_identity='agent-native-'+('0123456789abcdef-'*8)+'complete'
  t.send('/fixture-mail '+long_identity);t.until('mail-updated',6);mailrow,_=t.rail('lower')
  check(f'{width} UI05 oversized identity wraps without loss',long_identity in strip(''.join(mailrow['rows'])) and str(t.cwd) in strip(''.join(mailrow['rows'])) and all(c<=mailrow['width'] for c in mailrow['columns']),mailrow)
  t.send('/fixture-mail clear');t.until('mail-updated',7)
  t.capture('initial')
  # Native streaming and tools run in the actual compiled host, not a fake widget context.
  t.send('owned first prompt');t.until('tool-before');t.capture('active-tool');t.until('agent-end');t.drain(1)
  rails=[r for r in t.rows() if r.get('kind')=='rail' and r['key'].endswith('upper')]
  available=[r for r in rails if r['metrics']['generationRate']['status']=='available']
  check(f'{width} UI03 native rate equality',bool(available) and all((match:=re.search(r'([0-9]+(?:\.[0-9]+)?) tok/s',' '.join(r['rows']))) and abs(float(match.group(1))-r['metrics']['generationRate']['tokensPerSecond'])<=0.050000001 for r in available))
  tools=[r for r in t.rows() if r.get('kind') in ['tool-before','tool-after']]
  check(f'{width} UI03 native tool rate retained',len(tools)==2 and tools[0]['metrics']['generationRate']==tools[1]['metrics']['generationRate'],tools)
  check(f'{width} UI04 right edge live native rate',all(any(re.search(r'[0-9.]+ tok/s$',strip(line)) and columns==r['width'] for line,columns in zip(r['rows'],r['columns'])) for r in available),available[-1] if available else None)
  left_starts=[strip(r['rows'][next(i for i,line in enumerate(r['rows']) if '💰' in strip(line))]).index('💰') for r in rails if any('💰' in strip(line) for line in r['rows'])]
  check(f'{width} UI04 stable left facts',set(left_starts)=={0},left_starts)
  native=[strip(r['content']).replace('─','').strip() for r in t.rows() if r.get('kind')=='native-activity']
  lowerrails=[r for r in t.rows() if r.get('kind')=='rail' and r['key'].endswith('lower')]
  active=[n for n in native if re.search(r'\d+(?:\.\d+)?[sm]',n)]
  check(f'{width} UI04 native activity transitions observed',bool(active) and len(set(native))>1,native[-12:])
  check(f'{width} UI04 native activity shares complete lower facts',any(n in strip(''.join(r['rows'])) and str(t.cwd) in strip(''.join(r['rows'])) and 'GPT-6.1 Sol' in strip(''.join(r['rows'])) for n in active for r in lowerrails),lowerrails[-1] if lowerrails else None)
  idlelower,idletext=t.rail('lower')
  idle_native=[strip(r['content']).replace('─','').strip() for r in t.rows() if r.get('kind')=='native-activity']
  brand=next((n for n in native if n),None)
  check(f'{width} UI04 returned idle brand without stale timer',bool(brand) and idle_native[-1]==brand and brand in strip(''.join(idlelower['rows'])) and not re.search(r'\d+[smh](?:\s|$)',idletext),{'brand':brand,'lastNative':idle_native[-1],'lower':idlelower})
  t.capture('completed')
  for resized in [96 if width==80 else 80,width]:
   t.resize(resized);resizedrow,resizedtext=t.rail()
   check(f'{width} UI04 resize to {resized} preserves rate and facts',resizedrow['width']==resized and all(c<=resized for c in resizedrow['columns']) and all(s in resizedtext for s in ['💰','Week 41% left','5h 74% left']) and any(strip(line).endswith('tok/s') and columns==resized for line,columns in zip(resizedrow['rows'],resizedrow['columns'])),resizedrow)
  t.keys(b'\x1b[A');t.keys(b'\x1b[H');t.keys(b'X');r,_=t.rail()
  check(f'{width} EDITOR01 recall Home retains prompt',r['draft']=='Xowned first prompt',r['draft'])
  t.keys(b'\x03')
  # A draft remains in the real combined editor while the quota clock refreshes.
  t.keys(b'draft intact');t.drain(1);r,text=t.rail();check(f'{width} EDITOR01 draft retained',r['draft']=='draft intact' and r['editor']=='createEditor',r['draft'])
  t.keys(b'\x1b[H');t.keys(b'X');t.drain(.3);r,_=t.rail();check(f'{width} EDITOR01 Home beginning',r['draft']=='Xdraft intact',r['draft'])
  t.keys(b'\x1b[F');t.keys(b'Y');t.drain(.3);r,_=t.rail();check(f'{width} EDITOR01 End final',r['draft']=='Xdraft intactY',r['draft'])
  t.keys(b'\x1b[122;6u');r,_=t.rail();check(f'{width} EDITOR01 undo',r['draft']=='Xdraft intact',r['draft'])
  t.keys(b'\x1b[121;6u');r,_=t.rail();check(f'{width} EDITOR01 redo',r['draft']=='Xdraft intactY',r['draft'])
  t.keys(b'\x15');t.keys(b'\x1b[200~first line\nsecond line\x1b[201~');t.drain(.3)
  t.keys(b'\x1b[1;5H');t.keys(b'A');t.keys(b'\x1b[1;5F');t.keys(b'Z');r,_=t.rail()
  check(f'{width} EDITOR01 multiline Ctrl Home End',r['draft']=='Afirst line\nsecond lineZ',r['draft'])
  t.capture('draft');t.keys(b'\x03');t.drain(.2)
  # Real session construction and switching exercise the active manager's branch.
  t.send('/fixture-history 20');b=t.until('history-ready');r,text=t.rail();check(f'{width} CACHE04 branch B','💰 20%' in text,text)
  check(f'{width} UI02 automatic title source and complete text',b['titleOrigin']['source']=='auto' and title in text,text)
  t.send('/fixture-history 90');aa=t.until('history-ready',2);r,text=t.rail();check(f'{width} CACHE04 branch A','💰 90%' in text,text)
  t.send('/fixture-switch '+b['file']);t.until('switched');r,text=t.rail();check(f'{width} CACHE04 switch back B','💰 20%' in text,text)
  t.send('/fixture-case pair');t.until('case-ready');r,text=t.rail();check(f'{width} CACHE02 two completed requests','💰 50%' in text,text)
  t.send('/fixture-overlap');t.until('overlap');r,text=t.rail();check(f'{width} CACHE06 unequal history/live dedup','💰 50%' in text,text)
  t.send('/fixture-compact');compacted=t.until('compacted');r,text=t.rail();check(f'{width} CACHE04 real compaction retains response window',compacted['compactions']==1 and '💰 50%' in text,text)
  t.send('/fixture-model');t.until('model-switched');r,text=t.rail();check(f'{width} CACHE04 model retains branch','💰 50%' in text and 'Allowance unavailable' in text,text)
  for index,case in enumerate(['endings','zero','missing','old'],2):
   t.send('/fixture-case '+case);t.until('case-ready',index);r,text=t.rail()
   expected='50%' if case=='endings' else '50%' if case=='old' else 'unavailable'
   check(f'{width} CACHE03/05 {case}','💰 '+expected in text,text)
  ends=sum(row.get('kind')=='agent-end' for row in t.rows())
  t.send('/fixture-loop');t.send('owned twelve response turn');t.until('agent-end',ends+1);r,text=t.rail();check(f'{width} CACHE01 weighted live twelve tool responses','💰 47.9%' in text,text)
  t.send('/fixture-tree');tree=t.until('tree-ready');r,text=t.rail();check(f'{width} CACHE04 tree B excludes tool and model usage','💰 20%' in text,text)
  t.send('/fixture-navigate '+tree['first']);navigation=t.until('navigated');r,text=t.rail();check(f'{width} CACHE04 actual tree branch A',navigation['session']==tree['session'] and '💰 90%' in text,text)
  t.send('/fixture-navigate '+tree['second']);t.until('navigated',2);r,text=t.rail();check(f'{width} CACHE04 actual tree branch B','💰 20%' in text,text)
  t.send('/fixture-case meter-252000');t.until('case-ready',6);r,text=t.rail()
  check(f'{width} METER01 real budget-relative estimate','━━━━━━━━━━── 84%' in text and r['usage']['tokens']==252000,text)
  t.capture('meter84')
  t.send('/fixture-budget 1000');t.until('budget-changed')
  for count,(used,full,half,empty,percent) in enumerate([(0,0,0,12,'0%'),(460,5,1,6,'46%'),(500,6,0,6,'50%'),(999,11,1,0,'99.9%'),(1000,12,0,0,'100%'),(1050,12,0,0,'105%')],7):
   t.send('/fixture-case meter-'+str(used));t.until('case-ready',count);r,text=t.rail()
   check(f'{width} METER02 live {used}',('━'*full+'╸'*half+'─'*empty+' '+percent) in text,text)
  t.send('/fixture-budget 300000');t.until('budget-changed',2)
  t.send('/fixture-model model-one');t.until('model-switched',2)
  t.send('/fixture-case meter-150000');t.until('case-ready',13);r,text=t.rail();check(f'{width} METER03 initial 50',' 50%' in text,text)
  t.send('/fixture-budget 200000');t.until('budget-changed',3);r,text=t.rail();check(f'{width} METER03 central settings 75',' 75%' in text,text)
  t.send('/fixture-budget model');t.until('budget-changed',4);t.send('/fixture-model');t.until('model-switched',3);r,text=t.rail();check(f'{width} METER03 model-specific 60',' 60%' in text,text)
  t.send('/fixture-case meter-50000');t.until('case-ready',14);r,text=t.rail();check(f'{width} METER03 reduced context 20',' 20%' in text,text)
  t.send('/fixture-budget off');t.until('budget-changed',5);r,text=t.rail();check(f'{width} METER04 disabled',' ·  off  · ' in text,text)
  t.send('/fixture-budget 300000');t.until('budget-changed',6);t.send('/fixture-model no-window');t.until('model-switched',4);r,text=t.rail();check(f'{width} METER04 unavailable',' ·  unavailable  · ' in text,text)
  check(f'{width} EDITOR01 factory remains identical',len({r.get('editorIdentity') for r in t.rows() if r.get('kind')=='rail'})==1 and all(r.get('editor')=='createEditor' and r.get('editorIdentity')==1 for r in t.rows() if r.get('kind')=='rail'))
  t.capture('branch-model')
 finally:t.close()
for case,vcs_kind in [('weekly','git'),('no-reset','none'),('unavailable','none'),('exhausted','none')]:
 t=Terminal(80,case,vcs_kind)
 try:
  t.until('start');t.drain(1);r,text=t.rail();lower,lowertext=t.rail('lower')
  if case=='weekly':
   check('QUOTA02 weekly only','Week 41% left' in text and '5h ' not in text,text)
   check('VCS01 Git fallback','fix-cache' in lowertext and 'statusline-plan' not in lowertext,lowertext)
  else:check('VCS01 no fabricated label '+case,'fix-cache' not in lowertext and 'statusline-plan' not in lowertext,lowertext)
  if case=='no-reset':check('QUOTA02 missing reset remains explicit','Week 41% left · reset unavailable' in text and '5h ' not in text,text)
  if case=='unavailable':check('QUOTA02 no snapshot nonnumeric','Allowance unavailable' in text and 'Week ' not in text and '5h ' not in text,text)
  if case=='exhausted':
   check('QUOTA03 initial exhaustion','Week 4% left · reset 2h 0m' in text and '5h 0% left · reset 30m' in text,text)
   check('UI04 exhausted allowance uses error color',r['palette']['error']+'5h 0% left' in ''.join(r['rows']),r)
   t.send('/fixture-case pair');t.until('case-ready');r,text=t.rail()
   check('QUOTA03 begins with a real unequal-response cache window','💰 50%' in text,text)
   fetches_before_clock=r['quotaFetches']
   t.send('/fixture-clock');t.until('clock-advanced');t.keys(b'quota draft');r,text=t.rail()
   check('QUOTA03 idle countdown draft and cache retained','Week 4% left · reset 1h 55m' in text and '5h 0% left · reset 25m' in text and r['draft']=='quota draft' and '💰 50%' in text,text)
   check('QUOTA03 no response or fetch cadence introduced',r['calls']==0 and r['quotaFetches']==fetches_before_clock,{'calls':r['calls'],'fetches':r['quotaFetches'],'before':fetches_before_clock})
  t.capture('quota')
 finally:t.close()

# Actual compiled print embedding must be inert and terminate without a refresh timer.
home=root/'headless-home';home.mkdir();headless_log=root/'headless.jsonl'
env={**os.environ,'HOME':str(home),'PI_CODING_AGENT_DIR':str(home/'agent'),'STATUSLINE_EVIDENCE':str(headless_log),'DO_NOT_TRACK':'1'}
command=[a.candidate,'--no-extensions','-e',str(fixture),'--no-skills','--no-rules','--no-lsp','--no-title','--no-session','--model','statusline-ui-fixture/model-one','--config',str(config),'-p','/fixture-probe']
headless=subprocess.run(command,cwd=root,env=env,capture_output=True,timeout=30)
(root/'headless.stdout').write_bytes(headless.stdout);(root/'headless.stderr').write_bytes(headless.stderr)
observations=[json.loads(line) for line in headless_log.read_text().splitlines()]
check('ISOLATION01 actual headless inert',headless.returncode==0 and any(r['kind']=='probe' for r in observations) and not any(r['kind'] in ['widget-installed','rail'] for r in observations),headless.returncode)
if a.baseline:
 t=Terminal(80,'unsupported','none',a.baseline)
 try:
  t.until('start');t.drain(1);observations=t.rows()
  check('ISOLATION01 unsupported actionable native host',any(r['kind']=='notification' and 'supported compaction/rate/quota metrics API' in r['message'] for r in observations) and not any(r['kind']=='widget-installed' for r in observations))
  t.keys(b'native draft remains usable');t.capture('unsupported')
 finally:t.close()
check('staged bundle remains content-identical',all(checksum(bundle/asset['path'])==asset['sha256'] for asset in assets))
(root/'result.json').write_text(json.dumps({'status':'complete','candidate':str(candidate),'binarySha256':binary_digest,'bundle':str(bundle),'bundleAssets':str(root/'bundle-assets.json'),'version':version.stdout.strip(),'checks':checks,'captures':sorted(str(f) for f in root.glob('*.pty'))},indent=2))
print(json.dumps({'status':'complete','checks':len(checks),'evidence':str(root/'result.json')}))
