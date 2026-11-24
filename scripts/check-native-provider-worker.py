"""Exercise Rust host -> Rust worker -> fake provider CLI; no Node or paid requests."""
import json
import base64
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

project = Path(__file__).resolve().parent.parent
if os.name == 'nt':
    raise SystemExit('POSIX fake CLI fixture; run Windows process ownership tests separately.')
worker = Path(os.environ.get('QUORUM_TEST_NATIVE_WORKER', project / 'native/quorum-core/target/debug/quorum-provider-worker'))
host_binary = project / 'native/bin/quorum-chat-host'

with tempfile.TemporaryDirectory(prefix='quorum-native-provider-') as temporary:
    root = Path(temporary)
    expected = 'Rust 🦀 ' * 10000
    response = root / 'response.jsonl'
    response.write_text('\n'.join(json.dumps(event) for event in [
        {'type':'assistant','session_id':'native-session','message':{'id':'m','content':[{'type':'text','text':expected}]}},
        {'type':'result','usage':{'input_tokens':10,'output_tokens':20},'is_error':False},
    ])+'\n')
    fake = root / 'fake-claude'
    fake.write_text('#!/bin/sh\ncat >/dev/null\ncase "$*" in *claude-fable-5-2*) ;; *) exit 9;; esac\ncat '+shlex.quote(str(response))+'\nsleep 60 &\nexit 0\n')
    fake.chmod(0o755)

    def start(name, binary=fake, options=None, images=None, files=None):
        directory = root / name
        directory.mkdir(mode=0o700)
        (directory/'commands').mkdir()
        (directory/'acks').mkdir()
        bootstrap = {'executable':str(worker), 'worker':'--worker', 'payload':{
            'request':{'runId':name,'provider':'claude','cwd':str(root),'prompt':'native prompt','options':options or {'model':'fable','chatMode':'text'}},
            'settings':{'binaries':{'claude':str(binary)}}, 'apiKeys':{'fixture':'DO-NOT-PERSIST-NATIVE-KEY'},
        }}
        bootstrap['payload']['request']['images'] = images or []
        bootstrap['payload']['request']['files'] = files or []
        host = subprocess.Popen([str(host_binary),str(directory)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        host.stdin.write(json.dumps(bootstrap).encode())
        host.stdin.close()
        return host, directory

    host, directory = start('success')
    try:
        host.wait(timeout=10)
        events = [json.loads(line)['event'] for line in (directory/'events.jsonl').read_text().splitlines()]
        assert ''.join(event['delta'] for event in events if event['type']=='text') == expected
        assert len([event for event in events if event['type']=='done']) == 1
        assert events[-1]['ok']
        assert json.loads((directory/'state.json').read_text())['workerReady']
        assert all('DO-NOT-PERSIST-NATIVE-KEY' not in path.read_text(errors='replace') for path in directory.rglob('*') if path.is_file())
    finally:
        if host.poll() is None:
            (directory/'stop').touch()
            host.wait(timeout=10)
        host.stderr.close()

    image = root / 'snapshot.png'
    image.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
    captured = root / 'captured-input.json'
    attachment_cli = root / 'attachment-claude'
    attachment_cli.write_text('#!/bin/sh\ncat > '+shlex.quote(str(captured))+'\ncat '+shlex.quote(str(response))+'\n')
    attachment_cli.chmod(0o755)
    host, directory = start('attachments', attachment_cli, images=[str(image)], files=[{'name':'notes.txt','text':'Grüße 🦀\nexact snapshot'}])
    try:
        host.wait(timeout=10)
        events = [json.loads(line)['event'] for line in (directory/'events.jsonl').read_text().splitlines()]
        assert events[-1]['ok'], events[-1]
        payload = json.loads(captured.read_text())['message']['content']
        assert 'Grüße 🦀\nexact snapshot' in payload[0]['text']
        assert base64.b64decode(payload[1]['source']['data']) == image.read_bytes()
        assert payload[1]['source']['media_type'] == 'image/png'
    finally:
        if host.poll() is None:
            (directory/'stop').touch()
            host.wait(timeout=10)
        host.stderr.close()

    stubborn = root/'stubborn'
    stubborn.write_text('#!/bin/sh\ncat >/dev/null\nsleep 60\n')
    stubborn.chmod(0o755)
    host, directory = start('cancel', stubborn)
    try:
        deadline = time.monotonic()+5
        while not (directory/'state.json').exists() or not json.loads((directory/'state.json').read_text()).get('workerReady'):
            assert time.monotonic() < deadline
            time.sleep(.05)
        (directory/'stop').touch()
        host.wait(timeout=10)
        assert json.loads((directory/'state.json').read_text())['status']=='cancelled'
    finally:
        if host.poll() is None:
            host.kill()
            host.wait(timeout=5)
        host.stderr.close()

    host, directory = start('unsupported', options={'allowedTools':'Read'})
    host.wait(timeout=10)
    events = [json.loads(line)['event'] for line in (directory/'events.jsonl').read_text().splitlines()]
    assert events[-1]['ok'] is False and 'not implemented' in events[-1]['error']
    host.stderr.close()
    print('Native Rust pipeline: Unicode/chunking, Fable alias, image/text snapshots, orphaned-pipe exit, cancellation, private bootstrap and unsupported-option rejection passed.')
