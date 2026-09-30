"""Read only two nonsecret feature switches of one existing local AgentDash service.

Usage: inspect-service-features.py <checkout-cwd> <port>. Both are required. The Paperclip
instance directory defaults to ~/.paperclip/instances/default (PAPERCLIP_INSTANCE_DIR
overrides it).

Process output is captured privately; neither arguments nor environments are
printed/saved. Stale runtime metadata must match a live descendant index process.
"""
import datetime
import json
import re
import os
import subprocess
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit('usage: inspect-service-features.py <checkout-cwd> <port>')
service_cwd = str(Path(sys.argv[1]).resolve())
port = int(sys.argv[2])
instance_dir = Path(os.environ.get('PAPERCLIP_INSTANCE_DIR') or Path.home() / '.paperclip/instances/default')
records = []
for path in (instance_dir / 'runtime-services').glob('*.json'):
    record = json.loads(path.read_text())
    if record.get('port') == port and record.get('cwd') == service_cwd:
        records.append(record)
if len(records) != 1:
    raise RuntimeError('one governing service record required')
processes = subprocess.run(['/bin/ps', '-axo', 'pid,ppid,command'], capture_output=True, text=True, check=True, timeout=10)
rows = [line.split(None, 2) for line in processes.stdout.splitlines()[1:]]
rows = [(int(pid), int(parent), command) for pid, parent, command in rows]
descendants = {records[0]['metadata']['childPid']}
while True:
    expanded = descendants | {pid for pid, parent, _ in rows if parent in descendants}
    if expanded == descendants:
        break
    descendants = expanded
candidates = [(pid, command) for pid, _, command in rows if pid in descendants and 'src/index.ts' in command and '/node ' in command]
if len(candidates) != 1:
    raise RuntimeError('one live governing index process required')
pid = candidates[0][0]
process = subprocess.run(['/bin/ps', 'eww', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, check=True, timeout=10)
switches = {}
for name, allowed in {'AGENTDASH_HERMES_MANAGED_PROFILES': {'true', 'false'}, 'AGENTDASH_DEPLOYMENT_KIND': {'hosted', 'local', ''}}.items():
    match = re.search(r'(?:^|\s)' + name + r'=([^\s]*)', process.stdout)
    switches[name] = match[1] if match and match[1] in allowed else 'unexpected' if match else None
diagnostics = [pid for pid, _, command in rows if command.split()[:7] in [
    ['lsof', '-b', '-nP', f'-i4TCP:{port}', '-sTCP:LISTEN', '-Fp'],
    ['/usr/sbin/lsof', '-b', '-nP', f'-i4TCP:{port}', '-sTCP:LISTEN', '-Fp']]]
print(json.dumps({'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'servicePid': pid,
    'environmentVisible': all(re.search(r'(?:^|\s)' + name + '=', process.stdout) for name in ['HOME', 'PATH']),
    'selectedFeatureSwitches': switches, 'ownedDiagnosticPids': diagnostics,
    'qualification': 'Only selected nonsecret switches retained. Absence supports defaults only if environmentVisible; independently check HTTP hostedBox. No service mutation.'}, indent=2))
