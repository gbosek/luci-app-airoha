#!/usr/bin/env python3
"""Exercise shipped AWK probes and the PPE index split with host fixtures."""
from pathlib import Path
import argparse, json, re, subprocess

p=argparse.ArgumentParser();p.add_argument('--runtime-parser',type=Path);a=p.parse_args()
root=Path(__file__).resolve().parents[1]/'luci-app-airoha-npu'
rpc=(root/'root/usr/libexec/rpcd/luci.airoha_npu').read_text()
crypto=re.search(r"algostat=\$\(awk '(.*?)' /proc/crypto",rpc,re.S).group(1)
irq=re.search(r"irqs=\$\(awk '(.*?)' /proc/interrupts",rpc,re.S).group(1)
def awk(code,data):
    return subprocess.check_output(['awk',code],input=data,text=True).strip()
assert awk(irq,' 12: 10 20 30 40 GICv3 44 Level 1fb70000.crypto\n')=='100'
assert awk(irq,' 12: 10 20 30 40 GICv3 44 Level unrelated\n')==''
assert awk(crypto,'name : cbc(aes)\ndriver : cbc-aes-eip93\nrefcnt : 1\n\nname : sha256\ndriver : sha256-generic\nrefcnt : 999\n')=='1|1'
assert awk(crypto,'name : sha256\ndriver : sha256-generic\nrefcnt : 999\n')=='0|0'
js=(root/'htdocs/luci-static/resources/view/airoha_npu/status.js').read_text()
assert "_('Algorithm references')" in js and "_('In use')" not in js
assert "latestPpeSplit = (typeof ppe.ppe1 !== 'undefined' || typeof ppe.zero_l2 !== 'undefined') ? ppe : null" in js
# Execute real frontend delta logic and register-to-JSON helpers with host fixtures.
m=re.search(r"function cdmDeltaShare\(c\) \{.*?^\}",js,re.M|re.S);assert m
node="var cdmPrevSample={};\n"+m.group()+"\n"+r"""
if(cdmDeltaShare({reg:1,rx_cpu:100,rx_hwf:200})!==null)throw Error('first');
if(cdmDeltaShare({reg:1,rx_cpu:110,rx_hwf:230})!==75)throw Error('delta');
if(cdmDeltaShare({reg:1,rx_cpu:1,rx_hwf:1})!==null)throw Error('reset');
if(cdmDeltaShare({reg:1,rx_cpu:1,rx_hwf:1})!==null)throw Error('idle');
if(cdmDeltaShare({reg:2,rx_cpu:9,rx_hwf:99})!==null)throw Error('engine isolation');
"""
subprocess.run(['node','-e',node],check=True)
for name,base,expect in [('_gdm_json',256,{'tx':260,'rx':328,'rx_rc_drop':336,'rx_over_drop':340,'rx_error_drop':344}),('_cdm_json',768,{'tx':768,'rx_cpu':784,'rx_hwf':788,'rx_hwf_fast':792,'rx_cpu3_drop':860})]:
    body=re.search(r'^'+name+r'\(\) \{.*?^\}',rpc,re.M|re.S).group()
    code='_devmem32_at() { echo "$(( $1 + $2 ))"; }\n'+body+'\n'+name+' 1 '+str(base)+'\n'
    obj=json.loads(subprocess.check_output(['sh','-c',code],text=True))
    assert all(obj[k]==v for k,v in expect.items()),(name,obj)
    code='_devmem32_at() { return 1; }\n'+body+'\n'+name+' 1 '+str(base)+'\n'
    failed=subprocess.run(['sh','-c',code],capture_output=True,text=True)
    assert failed.returncode and not failed.stdout
# Run the shipped frame-engine function; a read failure must differ from a
# successfully measured zero without suppressing the other valid counters.
frame=re.search(r'^get_frame_engine\(\) \{.*?^\}',rpc,re.M|re.S).group()
for peak_read,expected in [('echo 589824',9),('echo 0',0),('return 1',None)]:
    code=r'''
devmem() { :; }
_devmem32() {
    case "$1" in
        0x1fb50104) echo 327692;;
        0x1fb50100) PEAK_READ;;
        *) return 1;;
    esac
}
_gdm_json() { printf '{"reg":%s}' "$1"; }
_cdm_json() { printf '{"reg":%s}' "$1"; }
'''.replace('PEAK_READ',peak_read)+frame+'\nget_frame_engine\n'
    obj=json.loads(subprocess.check_output(['sh','-c',code],text=True))
    assert obj['available'] and obj['pse']=={'used':5,'free':12,'peak':expected},obj
    assert len(obj['gdm'])==3 and len(obj['cdm'])==2,obj
acl=json.loads((root/'root/usr/share/rpcd/acl.d/luci-app-airoha-npu.json').read_text())
assert any('getCryptoInfo' in v.get('read',{}).get('ubus',{}).get('luci.airoha_npu',[]) for v in acl.values())
source=''.join(f'{idx} BND IPv4 5T orig=192.0.2.1:1->198.51.100.1:443 packets=18446744073709551615 bytes=18446744073709551615\n' for idx in ['0000','1fff','2000','3fff','4000'])
parsers=[root/'root/usr/libexec/airoha-ppe.awk']
if a.runtime_parser:parsers.append(a.runtime_parser)
for parser in parsers:
    raw=subprocess.check_output(['awk','-v','limit=1','-f',str(parser)],input=source,text=True)
    obj=json.loads(raw)
    assert (obj['ppe1'],obj['ppe2'],obj['dram'])==(2,2,1) and obj['total']==5 and len(obj['entries'])==1
    assert obj['entries'][0]['packets']=='18446744073709551615'
    legacy=json.loads(subprocess.check_output(['awk','-f',str(parser)],input='1234\n',text=True))
    assert legacy['bound']==1234 and 'ppe1' not in legacy and 'zero_l2' not in legacy
    mixed=source+'4001 UNB IPv4 5T eth=00:00:00:00:00:00->00:00:00:00:00:00 etype=0000\n'
    zeros=json.loads(subprocess.check_output(['awk','-v','limit=1','-f',str(parser)],input=mixed,text=True))
    assert zeros['zero_l2']==1 and zeros['zero_l2_bound']==0 and zeros['total']==6
    if a.runtime_parser and parser==a.runtime_parser:
        page=json.loads(subprocess.check_output(['awk','-v','limit=1','-v','offset=2','-f',str(parser)],input=source,text=True))
        assert page['total']==5 and page['entries'][0]['index']=='2000' and page['ppe1']==2 and page['has_more']
print(json.dumps({'crypto_probes':'passed','irq_cpu_columns_only':True,'references_not_sessions':True,'pse_peak_measured_zero_and_failure':'passed','parser_count':len(parsers),'full_scan_split_and_u64':'passed','pagination_preserved':bool(a.runtime_parser),'hardware_tested':False}))
