"""Native process lifecycle: detached completion, parallel runs, cancellation and process trees."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

project = Path(__file__).resolve().parent.parent
binary = project / 'native/bin' / ('quorum-chat-host.exe' if os.name == 'nt' else 'quorum-chat-host')
assert binary.exists(), 'Build the Rust chat host first'

worker_code = r'''
import json, os, pathlib, signal, subprocess, sys, time
boot = json.loads(sys.stdin.readline())
directory = pathlib.Path(boot['directory'])
if boot.get('grandchild'):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    (directory / 'grandchild.pid').write_text(str(child.pid))
if boot.get('stubborn'):
    signal.signal(signal.SIGTERM, lambda *_: None)
if boot.get('malformed'):
    print('malformed JSON', flush=True)
    time.sleep(10)
    sys.exit(1)
for index in range(boot.get('count', 5)):
    print(json.dumps({'type': 'text', 'delta': 'Grüße 🌍 ' + str(index)}), flush=True)
    time.sleep(boot.get('delay', .03))
if boot.get('stubborn'):
    time.sleep(30)
print(json.dumps({'type': 'done', 'ok': True}), flush=True)
'''


def read_state(directory):
    try:
        return json.loads((directory / 'state.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def wait_for(predicate, description, timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError(description)


def terminated(pid):
    try:
        if os.name != 'nt' and Path(f'/proc/{pid}/stat').exists():
            if Path(f'/proc/{pid}/stat').read_text().split(')')[1].strip().startswith('Z'):
                return True
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


with tempfile.TemporaryDirectory(prefix='quorum-native-chat-') as temporary:
    root = Path(temporary)
    worker = root / 'worker.py'
    worker.write_text(worker_code)
    hosts = []

    def launch(name, orphan=False, **options):
        directory = root / name
        directory.mkdir(mode=0o700)
        (directory / 'commands').mkdir()
        (directory / 'acks').mkdir()
        launch_data = json.dumps({'executable': sys.executable, 'worker': str(worker), 'payload': {'directory': str(directory), 'apiKeys': {'test': 'TOP-SECRET-PIPE-ONLY'}, **options}}).encode()
        if orphan:
            launcher = root / 'launcher.py'
            launcher.write_text("import subprocess,sys\np=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\np.stdin.write(sys.stdin.buffer.read());p.stdin.close()\nprint(p.pid)\n")
            result = subprocess.run([sys.executable, str(launcher), str(binary), str(directory)], input=launch_data, capture_output=True, timeout=5)
            assert result.returncode == 0, result.stderr
            return directory, int(result.stdout)
        host = subprocess.Popen([str(binary), str(directory)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=os.name != 'nt')
        host.stdin.write(launch_data)
        host.stdin.close()
        hosts.append(host)
        return directory, host.pid

    try:
        continued, continued_pid = launch('detached', orphan=True, count=10, delay=.07)
        wait_for(lambda: read_state(continued).get('status') == 'completed', 'detached job did not finish')
        completed = [json.loads(line) for line in (continued / 'events.jsonl').read_text().splitlines()]
        assert len(completed) == 11
        assert [event['sequence'] for event in completed] == list(range(1, 12))
        assert completed[-1]['event'] == {'type': 'done', 'ok': True}
        assert '🌍' in completed[0]['event']['delta']
        assert all('TOP-SECRET-PIPE-ONLY' not in file.read_text(errors='replace') for file in continued.rglob('*') if file.is_file()), 'bootstrap secrets must not be persisted'
        if os.name != 'nt':
            assert (continued / 'events.jsonl').stat().st_mode & 0o077 == 0

        slow, slow_pid = launch('cancelled', count=1, stubborn=True, grandchild=True)
        independent, independent_pid = launch('independent', count=15, delay=.05)
        wait_for(lambda: (slow / 'grandchild.pid').exists(), 'grandchild did not start')
        grandchild = int((slow / 'grandchild.pid').read_text())
        (slow / 'stop').touch()
        wait_for(lambda: read_state(slow).get('status') == 'cancelled', 'stubborn process tree was not cancelled', timeout=10)
        wait_for(lambda: terminated(grandchild), 'provider grandchild survived cancellation')
        wait_for(lambda: read_state(independent).get('status') == 'completed', 'cancelling another run interrupted independent chat')
        assert slow_pid != independent_pid

        malformed, _ = launch('malformed', malformed=True)
        wait_for(lambda: read_state(malformed).get('status') in ['failed', 'cancelled'], 'invalid worker output was not contained')
        events = [json.loads(line) for line in (malformed / 'events.jsonl').read_text().splitlines()]
        assert sum(event['event']['type'] == 'done' for event in events) == 1
        assert events[-1]['event']['ok'] is False
        duplicate = subprocess.run([str(binary), str(continued)], input=b'{}', capture_output=True, timeout=3)
        assert duplicate.returncode != 0, 'a completed job must not be silently rerun'
        print('Rust chat host: detached completion, secrets over pipes, ordered journals, parallel isolation, stop escalation, descendant cleanup and invalid output passed.')
    finally:
        for host in hosts:
            try:
                host.wait(timeout=2)
            except subprocess.TimeoutExpired:
                host.kill()
                host.wait(timeout=3)
            host.stderr.close()
