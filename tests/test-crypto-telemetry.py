#!/usr/bin/env python3
"""Exercise shipped AWK probes and the PPE index split with host fixtures."""
from pathlib import Path
import argparse, json, re, subprocess

p=argparse.ArgumentParser();p.add_argument('--runtime-parser',type=Path);a=p.parse_args()
root=Path(__file__).resolve().parents[1]/'luci-app-airoha-npu'
rpc=(root/'root/usr/libexec/rpcd/luci.airoha_npu').read_text()
crypto=re.search(r"algolist=\$\(awk '(.*?)' /proc/crypto",rpc,re.S).group(1)
irq=re.search(r"irqs=\$\(awk '(.*?)' /proc/interrupts",rpc,re.S).group(1)
def awk(code,data):
    return subprocess.check_output(['awk',code],input=data,text=True).strip()
assert awk(irq,' 12: 10 20 30 40 GICv3 44 Level 1fb70000.crypto\n')=='100'
assert awk(irq,' 12: 10 20 30 40 GICv3 44 Level unrelated\n')==''
assert awk(crypto,'name : cbc(aes)\ndriver : cbc-aes-eip93\nrefcnt : 1\n\nname : sha256\ndriver : sha256-generic\nrefcnt : 999\n')=='1|1|cbc(aes)'
assert awk(crypto,'name : sha256\ndriver : sha256-generic\nrefcnt : 999\n')=='0|0|'
js=(root/'htdocs/luci-static/resources/view/airoha_npu/status.js').read_text()
assert "_('Algorithm references')" in js and "_('In use')" not in js
assert "latestPpeSplit = (typeof ppe.ppe1 !== 'undefined') ? ppe : null" in js
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
    assert legacy['bound']==1234 and 'ppe1' not in legacy
    if a.runtime_parser and parser==a.runtime_parser:
        page=json.loads(subprocess.check_output(['awk','-v','limit=1','-v','offset=2','-f',str(parser)],input=source,text=True))
        assert page['total']==5 and page['entries'][0]['index']=='2000' and page['ppe1']==2 and page['has_more']
print(json.dumps({'crypto_probes':'passed','irq_cpu_columns_only':True,'references_not_sessions':True,'parser_count':len(parsers),'full_scan_split_and_u64':'passed','pagination_preserved':bool(a.runtime_parser),'hardware_tested':False}))
