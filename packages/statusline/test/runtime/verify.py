#!/usr/bin/env python3
"""Explicit offline feature gate: exact compiled candidate, real PTYs, owned profiles.
Keeps captures and observations. Never installs or starts an updater.
"""
import argparse,errno,fcntl,json,os,pathlib,pty,select,struct,subprocess,termios,time,re
p=argparse.ArgumentParser();p.add_argument('--candidate',required=True);p.add_argument('--output',required=True);p.add_argument('--expected-version',default='18.12.6');p.add_argument('--editor',required=True);p.add_argument('--baseline');a=p.parse_args()
root=pathlib.Path(a.output).resolve();root.mkdir(parents=True,exist_ok=False)
package=pathlib.Path(__file__).resolve().parents[2];fixture=pathlib.Path(__file__).with_name('fixture.ts')
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
  self.command=[binary or a.candidate,'--no-extensions','-e',str(pathlib.Path(a.editor).resolve()),'-e',str(fixture),'--no-skills','--no-rules','--no-lsp','--no-title','--auto-approve','--model','statusline-ui-fixture/model-one','--config',str(config),'--config',str(package/'overlay.json'),'--tools','fixture_wait']
  self.proc=subprocess.Popen(self.command,cwd=self.cwd,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=ctty,close_fds=True);os.close(slave)
 def rows(self):return [json.loads(row) for row in self.log.read_text().splitlines()] if self.log.exists() else []
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
for width in [80,96]:
 t=Terminal(width)
 try:
  t.until('start');t.drain(2)
  row,text=t.rail();lower,lowertext=t.rail('lower')
  title='🧭 Investigate cache accounting across the entire selected deployment boundary'
  check(f'{width} UI01/02 full user title',title in text,text)
  check(f'{width} QUOTA01 reported inline remaining',all(s in text for s in ['Week 41% left','5h 74% left','reset 5d 5h','reset 3h 12m']),text)
  check(f'{width} VCS01 jj first complete lower fields','statusline-plan' in lowertext and 'GPT-6.1 Sol' in lowertext and str(t.cwd) in lowertext,lowertext)
  check(f'{width} UI01 no counters or duplicate title',not any(s in text.replace(title,'')+lowertext for s in ['cache','cost','$','1000000']) and text.count(title)==1,text)
  t.capture('initial')
  # Native streaming and tools run in the actual compiled host, not a fake widget context.
  t.send('owned first prompt');t.until('tool-before');t.capture('active-tool');t.until('agent-end');t.drain(1)
  rails=[r for r in t.rows() if r.get('kind')=='rail' and r['key'].endswith('upper')]
  available=[r for r in rails if r['metrics']['generationRate']['status']=='available']
  check(f'{width} UI03 native rate equality',bool(available) and all((str(float(round(r['metrics']['generationRate']['tokensPerSecond'],1))).removesuffix('.0')+' tok/s') in ' '.join(r['rows']) for r in available))
  tools=[r for r in t.rows() if r.get('kind') in ['tool-before','tool-after']]
  check(f'{width} UI03 native tool rate retained',len(tools)==2 and tools[0]['metrics']['generationRate']==tools[1]['metrics']['generationRate'],tools)
  t.capture('completed')
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
  check(f'{width} EDITOR01 factory remains identical',all(r.get('editor')=='createEditor' for r in t.rows() if r.get('kind')=='rail'))
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
   t.send('/fixture-clock');t.until('clock-advanced');t.keys(b'quota draft');r,text=t.rail()
   check('QUOTA03 idle countdown and retained draft','Week 4% left · reset 1h 55m' in text and '5h 0% left · reset 25m' in text and r['draft']=='quota draft',text)
   check('QUOTA03 no response or fetch cadence introduced',r['calls']==0 and r['quotaFetches']==1,{'calls':r['calls'],'fetches':r['quotaFetches']})
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
(root/'result.json').write_text(json.dumps({'status':'complete','candidate':a.candidate,'version':version.stdout.strip(),'checks':checks,'captures':sorted(str(f) for f in root.glob('*.pty'))},indent=2))
print(json.dumps({'status':'complete','checks':len(checks),'evidence':str(root/'result.json')}))
