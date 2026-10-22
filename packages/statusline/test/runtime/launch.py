#!/usr/bin/env python3
"""Exercise the actual launcher exec, normal discovery, saved session, editor, layout and terminal restoration."""
import argparse,errno,fcntl,hashlib,json,os,pathlib,pty,select,shutil,struct,subprocess,termios,time
p=argparse.ArgumentParser();p.add_argument('--package',required=True);p.add_argument('--state',required=True);p.add_argument('--stock',required=True);p.add_argument('--output',required=True);a=p.parse_args()
root=pathlib.Path(a.output).resolve();root.mkdir();package=pathlib.Path(a.package).resolve();home=root/'home';agent=home/'agent';extensions=agent/'extensions';extensions.mkdir(parents=True)
shutil.copytree(package.parent/'editor/src',extensions/'editor');shutil.copyfile(package/'test/api-runtime/reader.ts',extensions/'provider.ts');shutil.copyfile(package/'test/runtime/launch-observer.ts',extensions/'observer.ts')
config=agent/'config.yml';config.write_text(json.dumps({'startup':{'setupWizard':False,'checkUpdate':False,'quiet':True},'composer':{'shape':'band'},'statusLine':{'preset':'default'},'autoTitle':False,'git':{'enabled':False}}));config_before=config.read_bytes()
env={'PATH':os.environ['PATH'],'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'XDG_CACHE_HOME':str(home/'cache'),'XDG_DATA_HOME':str(home/'data'),'XDG_STATE_HOME':str(home/'state'),'TERM':'xterm-256color','DO_NOT_TRACK':'1','METRICS_UNUSED':'1','METRICS_FAST':'1','METRICS_EVIDENCE':str(root/'provider.jsonl'),'OMP_STATUSLINE_STOCK':a.stock,'OMP_STATUSLINE_ROOT':a.state,'LAUNCH_EVIDENCE':str(root/'launch.jsonl')}
checks=[]
def check(name,condition,details=None):
 checks.append({'name':name,'pass':bool(condition),'details':details});(root/'checks.json').write_text(json.dumps(checks,indent=2));assert condition,(name,details)
def rows():return [json.loads(s) for s in (root/'launch.jsonl').read_text().splitlines()] if (root/'launch.jsonl').exists() else []
class Terminal:
 def __init__(self,label,command):
  self.label=label;self.raw=bytearray();self.before=len(rows());master,slave=pty.openpty();self.master=master;fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,96,0,0));self.original=termios.tcgetattr(slave)
  def ctty():os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
  self.proc=subprocess.Popen(command,cwd=root,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=ctty,close_fds=True);os.close(slave)
 def drain(self,seconds):
  end=time.monotonic()+seconds
  while time.monotonic()<end:
   if select.select([self.master],[],[],min(.05,max(0,end-time.monotonic())))[0]:
    try:self.raw.extend(os.read(self.master,65536))
    except OSError as e:
     if e.errno==errno.EIO:return
     raise
 def until(self,kind,timeout=40):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   self.drain(.1);found=[r for r in rows()[self.before:] if r['kind']==kind]
   if found:return found[-1]
   assert self.proc.poll() is None,(kind,self.proc.returncode,bytes(self.raw[-5000:]))
  raise TimeoutError((kind,bytes(self.raw[-5000:])))
 def send(self,text):os.write(self.master,(text+'\r').encode())
 def close(self):
  self.send('/owned-exit');self.until('exit');self.drain(2);status=self.proc.wait(timeout=15);restored=termios.tcgetattr(self.master);os.close(self.master);(root/(self.label+'.pty')).write_bytes(self.raw)
  check(self.label+' normal exit status',status==0,status);check(self.label+' terminal restored',restored[3]==self.original[3],{'before':self.original[3],'after':restored[3]})
common=['--no-skills','--no-rules','--no-lsp','--no-title','--model','statusline-owned-fixture/model-one']
seed=Terminal('stock-seed',[a.stock,*common]);seed.until('start');seed.send('/owned-seed');saved=seed.until('seeded');seed.close();check('stock normal plugins and editor loaded',saved['editor']=='createEditor',saved)
companion=Terminal('companion',['bun',str(package/'bin/omp-statusline'),*common,'--session',saved['file']]);loaded=companion.until('start');companion.send('/owned-probe');observed=companion.until('probe');companion.drain(2)
check('launcher exec retains original PID',observed['pid']==companion.proc.pid,observed)
check('same saved title session model history',observed['session']==saved['session'] and observed['title']==saved['title'] and observed['model']=='model-one' and any(e.get('type')=='message' and e.get('message',{}).get('content')=='owned retained history' for e in observed['branch']),observed)
check('ordinary existing editor retained',observed['editor']=='createEditor',observed)
check('companion per-invocation overlay',observed['shape']=='borderless' and observed['preset']=='custom',observed)
check('selected statusline actually rendered',b'Allowance unavailable' in companion.raw,companion.raw[-5000:].decode(errors='replace'));companion.close()
check('companion did not persist layout',config.read_bytes()==config_before)
stock=Terminal('stock-after',[a.stock,*common,'--session',saved['file']]);stock.until('start');stock.send('/owned-probe');normal=stock.until('probe');stock.drain(1)
check('subsequent stock keeps ordinary layout',normal['shape']=='band' and normal['preset']=='default',normal);check('stock has no companion-only rails',b'Allowance unavailable' not in stock.raw);stock.close();check('ordinary configuration preserved',config.read_bytes()==config_before)
(root/'result.json').write_text(json.dumps({'status':'passed','checks':checks,'saved':saved,'companion':observed,'stock':normal},indent=2))
