#!/usr/bin/env python3
"""Exercise actual merged WAN, history and cache code without device writes."""
from pathlib import Path
import json, os, re, subprocess, tempfile
R=Path(__file__).resolve().parents[1]
app=R/'luci-app-clients'
probe=(app/'root/usr/libexec/clients-probe').read_text()
rpc=(R/'luci-app-airoha-npu/root/usr/libexec/rpcd/luci.airoha_npu').read_text()
common=(R/'luci-app-airoha-npu/root/usr/libexec/rpcd/airoha-common.sh').read_text()
ucode=os.environ.get('UCODE_BIN') or os.environ.get('UCODE') or 'ucode'
def fn(s,n): return re.search(r'^(?:function )?'+re.escape(n)+r'\([^\n]*\) \{.*?^\}',s,re.M|re.S).group()
def uc(code):
 with tempfile.NamedTemporaryFile(suffix='.uc',mode='w') as f:
  f.write(code);f.flush()
  p=subprocess.run([ucode,f.name],capture_output=True,text=True,timeout=10)
  assert p.returncode==0,(p.stdout,p.stderr)

wan=probe[probe.index('let wan_cache ='):probe.index('/* ---------------- nlbwmon')]
uc('''let dump=null, counters={}, clock=100;
const WAN_CANDIDATES=['pppoe-wan','wan'];
function time(){return clock;}
function counter(dev,key){return counters[dev];}
function connect(){return {call:()=>dump,disconnect:()=>null};}
'''+wan+fn(probe,'grew')+fn(probe,'sample_scopes')+'''
let bridge={members:['lan1','lan2']};
counters={'pppoe-wan':100,'pppoe-wanb':200,'pon0':300,'lan3':400};
dump={interface:[
 {interface:'wan',up:true,l3_device:'pppoe-wan',route:[{target:'0.0.0.0',mask:0}]},
 {interface:'wan_6',up:true,l3_device:'pppoe-wan',route:[{target:'::',mask:0}]},
 {interface:'wanb',up:true,l3_device:'pppoe-wanb',route:[{target:'0.0.0.0',mask:0}]},
 {interface:'lan',up:true,l3_device:'lan1',route:[{target:'0.0.0.0',mask:0}]}
]};
let discovered=wan_devices(bridge);
assert(length(discovered)==2 && discovered[0]=='pppoe-wan' && discovered[1]=='pppoe-wanb','dual WAN or IPv6 duplicate: '+sprintf('%J',discovered));
dump.interface[2].up=false; clock=131;
assert(length(wan_devices(bridge))==1 && wan_devices(bridge)[0]=='pppoe-wan','down WAN included');
dump={interface:[]};clock=162;
assert(length(wan_devices(bridge))==0,'inactive interfaces resurrected by fallback');
dump=null;clock=193;
assert(length(wan_devices(bridge))==2,'fallback lost second PPPoE');
assert(wan_devices({uplink:'wan'})[0]=='wan','AP compatibility');
let before={'lan1':[100,100],'pppoe-wan':[100,100],'pppoe-wanb':[100,100]};
let cur={'lan1':{rx:1000,tx:1100},'pppoe-wan':{rx:400,tx:300},'pppoe-wanb':{rx:500,tx:600}};
let got=sample_scopes(cur,before,['pppoe-wan','pppoe-wanb']);
assert(got.wanUp==700 && got.wanDown==700 && got.lanUp==200 && got.lanDown==300,'dual scopes');
assert(sample_scopes({'wan':{rx:50,tx:20}},{wan:[100,100]},'wan').wanUp==0,'reset');
assert(sample_scopes(cur,{},['pppoe-wan']).wanUp==0,'unmeasured baseline');
''')

# The browser must sum exactly the same two logical WANs as the sampler.
js=r'''const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const common=new Function('rpc','fs','network','uci','L','E','_',s)(
 {declare:()=>()=>Promise.resolve({})},{},{},{},{Class:{extend:o=>o}},()=>null,x=>x);
const store=common.createStore();
store.state={bridge:{wan:'pppoe-wan',wans:['pppoe-wan','pppoe-wanb']}};
store.portRates={lan1:{rx:900,tx:1000},'pppoe-wan':{rx:300,tx:200},'pppoe-wanb':{rx:400,tx:500}};
assert.deepStrictEqual({...store.bridgeRates(false)},{lanUp:200,lanDown:300,wanUp:700,wanDown:700});
store.state={bridge:{uplink:'wan'}};store.portRates={lan1:{rx:30,tx:50},wan:{rx:40,tx:20}};
assert.deepStrictEqual({...store.bridgeRates(false)},{lanUp:10,lanDown:10,wanUp:20,wanDown:40});
'''
subprocess.run(['node','-e',js,str(app/'htdocs/luci-static/resources/view/status/clients/common.js')],check=True)
npu_js=(R/'luci-app-airoha-npu/htdocs/luci-static/resources/view/airoha_npu/status.js').read_text()
history_js='var HIST_WINDOW=120;\n'+'\n'.join(fn(npu_js,n) for n in ['histNum','histNormalise','parseFreqHistory','parseLoadHistory'])
history_js+='''
const assert=require('assert');
assert.deepStrictEqual(parseLoadHistory([[110,[43,null,1000]], [100,[200]]]),
 [{t:100000,u:[20]},{t:110000,u:[4.3,null,100]}]);
assert.strictEqual(parseLoadHistory(null),null);
assert.deepStrictEqual(parseFreqHistory([[100,500000],[100,500000],[110,1000000]]),
 [{t:100000,v:500000},{t:110000,v:1000000}]);
'''
subprocess.run(['node','-e',history_js],check=True)

# Run both real cache wrappers: success hits cache, failures do not poison it;
# expired and future timestamps are rebuilt. All files are private fixtures.
with tempfile.TemporaryDirectory(prefix='airoha-cache-') as d:
 d=Path(d)
 for name,source,cache,live,answer in [
  ('get_frame_engine',rpc,'/tmp/luci-airoha-npu.frame.cache','_get_frame_engine_live','{"available":true,"pse":{"peak":0}}'),
  ('airoha_port_topology_json',common,'$airoha_topology_json_cache','_airoha_port_topology_json_live','{"ports":[{"name":"lan1"}]}')]:
  for mode in ['normal','failed','expired','future']:
   cached=d/'cache';count=d/'count';cached.unlink(missing_ok=True);count.write_text('')
   value=answer if mode!='failed' else ('{"available":false}' if name=='get_frame_engine' else '{"ports":[]}')
   body=fn(source,name).replace('"'+cache+'"','"'+str(cached)+'"')
   if mode in ['expired','future']:cached.write_text(('1' if mode=='expired' else '9999999999')+'\n'+answer+'\n')
   code=f'''airoha_topology_json_ttl=15
date() {{ echo 100; }}
{live}() {{ echo x >> '{count}'; printf '%s' '{value}'; }}
'''+body+'\n'+name+'\nprintf "\\n"\n'+name+'\n'
   p=subprocess.run(['sh','-c',code],capture_output=True,text=True,check=True)
   assert len(count.read_text().splitlines())==(2 if mode=='failed' else 1),(name,mode,p.stdout)
   assert len([json.loads(x) for x in p.stdout.splitlines()])==2

# Real history sampling: same tick is not duplicated; delta ticks create a
# measured sample and reset/corrupt counters do not invent a load curve.
with tempfile.TemporaryDirectory(prefix='airoha-history-') as d:
 d=Path(d);freq=d/'freq';load=d/'load';base=d/'base';stat=d/'stat'
 code=fn(rpc,'_hist_append')+'\n'+fn(rpc,'_cpu_hist_sample').replace('/proc/stat',str(stat))
 code=f'HIST_FREQ="{freq}"; HIST_LOAD="{load}"; HIST_BASE="{base}"; HIST_GATE=8; HIST_MAX=120\n'+code
 code+=f'''\nprintf 'cpu0 10 0 10 80 0 0 0 0 0 0\\n' > '{stat}'
_cpu_hist_sample 500000 100
_cpu_hist_sample 500000 100
printf 'cpu0 20 0 20 160 0 0 0 0 0 0\\n' > '{stat}'
_cpu_hist_sample 1000000 110
'''
 subprocess.run(['sh','-c',code],capture_output=True,text=True,check=True)
 assert len(freq.read_text().splitlines())==2
 fields=load.read_text().split();assert fields==['110','200'],fields
print('PASS: real ucode dual-WAN/IPv6 alias/down/reset/AP cases; browser agreement; cache hit/failure/expiry/clock rollback; actual CPU history sampling')
