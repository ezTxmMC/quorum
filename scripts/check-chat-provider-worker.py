"""Exercise the actual Rust host -> bundled Node adapter -> fake CLI pipeline, without provider requests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

project = Path(__file__).resolve().parent.parent
if os.name == 'nt':
    raise SystemExit('Fake shell CLI integration is currently tested on POSIX; native lifecycle tests are cross-platform.')
node = shutil.which('node')
with tempfile.TemporaryDirectory(prefix='quorum-provider-worker-') as temporary:
    root = Path(temporary)
    directory = root / 'job'
    directory.mkdir(mode=0o700)
    (directory / 'commands').mkdir()
    (directory / 'acks').mkdir()
    expected = 'x' * 15999 + '🦀' + ' Grüße 🌍' * 5000
    fake = root / 'fake-claude'
    fixture = root / 'response.jsonl'
    fixture.write_text('\n'.join(json.dumps(event) for event in [
        {'type':'system','subtype':'init','session_id':'fake-session'},
        {'type':'assistant','message':{'content':[{'type':'text','text':expected}]}},
        {'type':'result','subtype':'success','is_error':False,'result':expected,'session_id':'fake-session'},
    ])+'\n')
    fake.write_text('#!/bin/sh\ncat >/dev/null\ncat '+str(fixture)+'\n')
    fake.chmod(0o755)
    bootstrap = {
        'executable': node, 'worker': str(project / 'dist-electron/chat-worker.js'),
        'payload': {
            'request': {'runId': 'fixture', 'provider': 'claude', 'prompt': 'fixture', 'cwd': str(root), 'options': {'chatMode': 'coding'}},
            'dataRoot': str(root / 'data'), 'jobDirectory': str(directory), 'pythonRoot': str(project / 'python'),
            'settings': {'binaries': {'claude': str(fake)}, 'apiConnections': [], 'acpAgents': [], 'localRuntime': {}, 'ollama': {}},
            'apiKeys': {'fixture': 'DO-NOT-PERSIST-KEY'},
        },
    }
    host = subprocess.Popen([str(project / 'native/bin/quorum-chat-host'), str(directory)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        host.stdin.write(json.dumps(bootstrap).encode())
        host.stdin.close()
        host.wait(timeout=20)
        assert host.returncode == 0, host.stderr.read().decode()
        events = [json.loads(line)['event'] for line in (directory / 'events.jsonl').read_text().splitlines()]
        assert events[-1]['type'] == 'done' and events[-1]['ok'], events[-1]
        text = ''
        for event in events:
            if event['type'] == 'text':
                text += event['delta']
            if event['type'] == 'text_full':
                text = event['text']
        assert text == expected, f'long Unicode response changed: got {len(text)}, expected {len(expected)}; event sizes {[(event["type"], len(event.get("delta", event.get("text", "")))) for event in events]}; first difference {next(((i,repr(a),repr(b)) for i,(a,b) in enumerate(zip(text,expected)) if a != b), None)}'
        assert len([event for event in events if event['type'] == 'done']) == 1
        state = json.loads((directory / 'state.json').read_text())
        assert state['status'] == 'completed'
        assert state['workerReady'], 'adapter must confirm initialization before detach'
        assert all('DO-NOT-PERSIST-KEY' not in path.read_text(errors='replace') for path in directory.rglob('*') if path.is_file())
        print('Provider worker: Rust supervisor, bundled adapter, fake Claude CLI, long Unicode response, exactly one completion and secret isolation passed.')
    finally:
        if host.poll() is None:
            host.kill()
            host.wait(timeout=5)
        host.stderr.close()
