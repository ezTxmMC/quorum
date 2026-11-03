"""Run actual installed TypeScript/Python servers against the Quorum manager without sockets."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading

project = Path(__file__).resolve().parent.parent
node = shutil.which("node")
assert node, "Node is required"


def relay(source, destination):
    try:
        while True:
            data = source.read1(65536)
            if not data:
                return
            destination.write(data)
            destination.flush()
    except (BrokenPipeError, OSError, ValueError):
        return


for language, package, entry, suffix in [
    ("typescript", "typescript-language-server", "lib/cli.mjs", ".ts"),
    ("python", "pyright", "langserver.index.js", ".py"),
]:
    with tempfile.TemporaryDirectory(prefix="quorum-lsp-server-") as temporary:
        root = Path(temporary)
        source = root / f"sample{suffix}"
        source.write_text("# initial\n" if language == "python" else "// initial\n")
        environment = {key: os.environ[key] for key in ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "TMPDIR", "TEMP", "TMP", "LANG"] if key in os.environ}
        server = subprocess.Popen(
            [node, str(project / "node_modules" / package / entry), "--stdio"],
            cwd=root, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt",
        )
        client = subprocess.Popen(
            [node, "--experimental-strip-types", str(project / "scripts/check-lsp-server-relay.mjs"), language, str(root), str(source)],
            cwd=project, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        threads = [threading.Thread(target=relay, args=(client.stdout, server.stdin), daemon=True), threading.Thread(target=relay, args=(server.stdout, client.stdin), daemon=True)]
        for thread in threads:
            thread.start()
        try:
            code = client.wait(timeout=60)
            output = client.stderr.read().decode("utf-8", errors="replace")
            assert code == 0, output
            print(output.strip())
        finally:
            if client.poll() is None:
                client.kill()
            client.wait(timeout=5)
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(server.pid), "/T", "/F"], capture_output=True, timeout=5)
                else:
                    os.killpg(server.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            server.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=2)
            for stream in [client.stdin, client.stdout, client.stderr, server.stdin, server.stdout]:
                stream.close()
print("Real language server integration checks passed.")
