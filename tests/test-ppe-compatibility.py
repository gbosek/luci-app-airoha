#!/usr/bin/env python3
"""Offline PPE counter/bridge-control regressions; no device access."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
APP = REPO / 'luci-app-airoha-npu'


def run(argv, **kwargs):
    result = subprocess.run(argv, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise AssertionError((argv, result.returncode, result.stdout[-1000:], result.stderr[-1500:]))
    return result.stdout


def function(text, name):
    match = re.search(r'^' + re.escape(name) + r'\(\) \{.*?^\}', text, re.M | re.S)
    assert match, name
    return match.group(0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--actions', type=Path)
    args = parser.parse_args()
    awk = APP / 'root/usr/libexec/airoha-ppe.awk'
    rpc = (APP / 'root/usr/libexec/rpcd/luci.airoha_npu').read_text()
    common = (APP / 'root/usr/libexec/rpcd/airoha-common.sh').read_text()
    with tempfile.TemporaryDirectory(prefix='airoha-ppe-compat-') as temp:
        root = Path(temp)
        records = root / 'entries'
        # A bridge fallback can keep the learned IPv4 type and unchanged tuple.
        # Do not classify these as conntrack flags or count only L2B entries.
        records.write_text(''.join(
            f'{i:05x} BND IPv4 5T orig=192.0.2.2:50000->198.51.100.3:443 '
            'new=192.0.2.2:50000->198.51.100.3:443 '
            'eth=02:00:00:00:00:01->02:00:00:00:00:02 etype=0800 vlan=0,0 '
            'packets=18446744073709551615 bytes=9007199254740993\n'
            for i in range(1537)) +
            '01000 BND L2B eth=02:00:00:00:00:01->02:00:00:00:00:02 packets=0 bytes=0\n' +
            '01001 BND IPv6 5T orig=[2001:db8::1]:1->[2001:db8::2]:2\n' +
            '01002 UNB IPv4 5T packets=0 bytes=0\n' +
            '01003 FIN IPv4 5T packets=5 bytes=300\n')
        parsed = json.loads(run(['awk', '-v', 'limit=1024', '-f', str(awk), str(records)]))
        assert parsed['total'] == 1541 and parsed['bound'] == 1539
        assert parsed['unbound'] == 1 and parsed['finished'] == 1
        assert parsed['ipv4'] == 1539 and parsed['ipv6'] == 1 and parsed['l2b'] == 1
        assert len(parsed['entries']) == 1024 and parsed['truncated'] is True
        assert parsed['entries'][0]['packets'] == '18446744073709551615'
        assert parsed['entries'][0]['bytes'] == '9007199254740993'
        assert parsed['entries'][0]['orig'] == parsed['entries'][0]['new_flow']
        all_rows = json.loads(run(['awk', '-v', 'limit=4096', '-f', str(awk), str(records)]))
        assert all_rows['entries'][1537]['packets'] == '0'
        assert all_rows['entries'][1537]['bytes'] == '0'
        assert all_rows['entries'][1538]['packets'] is None
        assert all_rows['entries'][1538]['bytes'] is None
        filtered = json.loads(run(['awk', '-v', 'state_filter=BND', '-v', 'limit=50', '-f', str(awk), str(records)]))
        assert filtered['total'] == filtered['bound'] == 1539
        assert len(filtered['entries']) == 50 and filtered['truncated'] is True

        # Exercise the real exported board/control functions. On XG2010G the
        # unsupported result must happen before parsing requests or writing sysctl.
        support = function(common, 'airoha_bridge_offload_supported')
        controls = '\n'.join(function(rpc, name) for name in (
            'get_vlan_offload', 'set_vlan_offload', 'get_apmode_offload', 'set_apmode_offload', 'set_pppoe_offload'))
        for board in ('gemtek,xg2010g', 'gemtek,xg2010g-ubi', 'gemtek,xg2010g-2g-ubi'):
            program = f"airoha_board_compat() {{ echo '{board}'; }}\n" + support + '\n' + controls
            program += '\nget_vlan_offload\nset_vlan_offload\nget_apmode_offload\nset_apmode_offload\nset_pppoe_offload\n'
            replies = [json.loads(line) for line in run(['bash', '-c', program]).splitlines()]
            assert len(replies) == 5
            assert replies[0].get('supported') is False and replies[2].get('supported') is False
            assert all('not supported on XG2010G' in replies[i].get('error', '') for i in (1, 3, 4))

        # A driver RX binding path must not silently weaken the existing active
        # WAN restriction of the separate legacy netfilter controls.
        gate = function(rpc, '_bridge_offload_blocked')
        assert run(['bash', '-c', '_has_active_wan() { return 0; }\n' + gate + '\n_bridge_offload_blocked; echo $?']).strip() == '0'
        assert run(['bash', '-c', '_has_active_wan() { return 1; }\n' + gate + '\n_bridge_offload_blocked; echo $?']).strip() == '1'
        print('PASS: full BND summary, IPv4 bridge format, exact uint64/missing counters, retained XG/active-WAN controls')

        if args.actions:
            actions = args.actions.resolve()
            spec = importlib.util.spec_from_file_location('observability', actions / 'scripts/observability.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            staged = root / 'app'
            shutil.copytree(APP, staged)
            module.adapt_observability(staged, 'naoki')
            adapted_rpc = (staged / 'root/usr/libexec/rpcd/luci.airoha_npu').read_text()
            assert 'getPpeExport' in adapted_rpc
            assert '/usr/libexec/airoha-ppe-snapshot.sh' in adapted_rpc
            acl = json.loads((staged / 'root/usr/share/rpcd/acl.d/luci-app-airoha-npu.json').read_text())
            assert 'getPpeExport' in acl['luci-app-airoha-npu']['read']['ubus']['luci.airoha_npu']
            for rel in ('root/usr/libexec/rpcd/luci.airoha_npu', 'root/usr/libexec/rpcd/airoha-common.sh',
                        'root/usr/libexec/airoha-ppe-snapshot.sh', 'root/usr/libexec/airoha-deadline.sh'):
                run(['sh', '-n', str(staged / rel)])
            print(run(['python3', str(actions / 'Runtime/tests/runtime-test.py')]).strip())
            print('PASS: existing firmware adapter applies, full-export RPC/ACL registered, shell syntax valid')
            print('adapter_sha256=' + hashlib.sha256((actions / 'scripts/observability.py').read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
