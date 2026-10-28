#!/usr/bin/env python3
"""Run the shipped conntrack parser with real ucode under memory/time limits."""
import argparse
import hashlib
import json
import os
import resource
import subprocess
import tempfile
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--report', type=Path)
a = p.parse_args()
repo = Path(__file__).resolve().parents[1]
source = repo / 'luci-app-clients/root/usr/libexec/clients-probe'
text = source.read_text()
parser = text[text.index('function find_from('):text.index('\nfunction in_any_v4')]
fixtures = [
    ('', None), ('other src=a dst=b', None), ('ipv4 2 tcp 6', {'family': 4, 'tuples': []}),
]
for family in (4, 6):
    src, dst = ('192.168.10.66', '1.1.1.1') if family == 4 else ('2001:db8::1', '2001:db8::2')
    prefix = f'ipv{family} 2 tcp 6 ESTABLISHED '
    for sep in (' ', '\t'):
        for counters in (False, True):
            line = prefix + f'src={src}{sep}dst={dst}{sep}sport=12345{sep}dport=443{sep}'
            line += ('packets=1 bytes=4294967297 ' if counters else '')
            line += f'src={dst}{sep}dst={src}{sep}sport=443{sep}dport=12345{sep}'
            line += ('packets=2 bytes=9007199254740991 ' if counters else '')
            fixtures.append((line, {'family': family, 'tuples': [
                {'src': src, 'dst': dst, 'bytes': 4294967297 if counters else 0},
                {'src': dst, 'dst': src, 'bytes': 9007199254740991 if counters else 0}]}))
    fixtures += [
        (prefix + f'src={src} dst={dst} src={dst} dst={src} bytes=200',
         {'family': family, 'tuples': [{'src': src, 'dst': dst, 'bytes': 0}, {'src': dst, 'dst': src, 'bytes': 200}]}),
        (prefix + f'src={src}', {'family': family, 'tuples': [{'src': src, 'dst': None, 'bytes': 0}]}),
        (prefix + 'src=a dst=b bytes=1 src=c dst=d bytes=2 src=e dst=f bytes=3',
         {'family': family, 'tuples': [{'src': 'a', 'dst': 'b', 'bytes': 1}, {'src': 'c', 'dst': 'd', 'bytes': 2}]}),
    ]

def limits():
    resource.setrlimit(resource.RLIMIT_AS, (32 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))

with tempfile.TemporaryDirectory(prefix='clients-parser-') as directory:
    script = Path(directory) / 'test.uc'
    script.write_text(parser + '\nlet cases = ' + json.dumps(fixtures) + ''';
for (let item in cases)
    assert(sprintf('%J', split_tuple(item[0])) == sprintf('%J', item[1]), 'tuple mismatch');
for (let i = 0; i < 10000; i++)
    assert(length(split_tuple(cases[3][0]).tuples) == 2, 'parser did not terminate');
print('passed');
''')
    result = subprocess.run([os.environ['UCODE_BIN'], str(script)], capture_output=True, text=True,
                            timeout=15, preexec_fn=limits)
    assert result.returncode == 0 and result.stdout == 'passed', result.stderr
dns_path = repo / 'luci-app-clients/root/usr/libexec/clients-dns'
dns_source = dns_path.read_text()
reader = dns_source[dns_source.index('function read_log_chunk('):dns_source.index('/* ---------------- collect ---------------- */')]
with tempfile.TemporaryDirectory(prefix='clients-dns-reader-') as directory:
    log = Path(directory) / 'log'
    log.write_text('first-line\nsecond-line\n' + 'x' * 100000)
    script = Path(directory) / 'test.uc'
    script.write_text("let fs=require('fs');\nconst DEFAULT_LOG=" + json.dumps(str(log)) + ";\n" + reader + '\nlet path=' + json.dumps(str(log)) + ";\n" + """
assert(read_log_chunk(path, 11, 12) == 'second-line\\n', 'offset was ignored');
assert(length(read_log_chunk(path, 0, 100000)) == 65536, 'unbounded log read');
assert(read_log_chunk(path, 999999, 10) == '', 'EOF');
assert(read_log_chunk(path + '-missing', 0, 10) == '', 'missing log');
assert(!rotate_consumed_log(path, 11), 'short/unread log must remain');
fs.writefile(path, sprintf('%01048576d', 0));
assert(!rotate_consumed_log(path, 1048575), 'must archive all bytes first');
assert(rotate_consumed_log(path, 1048576), 'consumed default log must rotate');
assert(length(fs.readfile(path)) == 0, 'raw RAM log not bounded');
fs.unlink(path); fs.writefile(path + '-target', sprintf('%01048576d', 0)); fs.symlink(path + '-target', path);
assert(!rotate_consumed_log(path, 1048576), 'must refuse a symlink');
assert(length(fs.readfile(path + '-target')) == 1048576, 'symlink target modified');
print('passed');
""")
    result = subprocess.run([os.environ['UCODE_BIN'], str(script)], capture_output=True, text=True,
                            timeout=5, preexec_fn=limits)
    assert result.returncode == 0 and result.stdout == 'passed', result.stderr

report = {'status': 'passed', 'parser_cases': len(fixtures), 'repeat_parses': 10000,
          'dns_read_cases': 4, 'dns_rotation_cases': 4, 'dns_batch_limit_bytes': 65536,
          'clients_dns_sha256': hashlib.sha256(dns_path.read_bytes()).hexdigest(),
          'memory_limit_mib': 32, 'cpu_limit_seconds': 10,
          'clients_probe_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
          'hardware_tested': False}
if a.report:
    a.report.parent.mkdir(parents=True, exist_ok=True)
    a.report.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
