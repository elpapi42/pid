"""Drive human menus and the JSON protocol through a real PTY."""
import json
import os
import pty
import select
import subprocess
import sys
import termios
import time

mode = sys.argv[3]
master, slave = pty.openpty()
args = [sys.argv[1], sys.argv[2], "auth", "login", "faux"]
if mode == "json":
    args.append("--json")
child = subprocess.Popen(args, stdin=slave, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE if mode == "json" else slave,
                         env={**os.environ, "NO_COLOR": "1", "TERM": "xterm-256color"})
os.close(slave)
streams = [master, child.stdout.fileno()]
if child.stderr:
    streams.append(child.stderr.fileno())
terminal = b""
stdout = b""
stderr = b""
pending = b""
stage = 0
mode_checks = []
deadline = time.monotonic() + 10
try:
    while streams and time.monotonic() < deadline:
        readable, _, _ = select.select(streams, [], [], 0.1)
        for descriptor in readable:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                streams.remove(descriptor)
                continue
            if descriptor == master:
                terminal += chunk
            elif descriptor == child.stdout.fileno():
                stdout += chunk
            else:
                stderr += chunk
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    event = json.loads(line)
                    if event.get("type") == "auth_prompt":
                        prompt = event["prompt"]["type"]
                        mode_checks.append((prompt, bool(termios.tcgetattr(master)[3] & termios.ECHO)))
                        answer = {"select": "oauth", "text": "visible name", "secret": "pty-synthetic-secret"}[prompt]
                        os.write(master, (answer + "\r").encode())
        if mode != "json":
            if stage == 0 and b"Authentication method" in terminal and b"OAuth" in terminal:
                os.write(master, b"\x03" if mode == "cancel" else b"\x1b[B\r")
                stage = 1
            elif stage == 1 and mode != "callback" and b"Name" in terminal:
                os.write(master, b"visible name\r")
                stage = 2
            elif stage == 2 and b"Password" in terminal:
                os.write(master, b"pty-synthetic-secret\r")
                stage = 3
        if child.poll() is not None and streams == [master]:
            break
    child.wait(timeout=1)
    assert b"pty-synthetic-secret" not in terminal + stdout + stderr, "secret must stay hidden"
    assert termios.tcgetattr(master)[3] & termios.ECHO, "terminal echo must be restored"
    if mode == "cancel":
        assert child.returncode == 130, terminal.decode(errors="replace")
        assert stdout == b""
    else:
        assert child.returncode == 0, (terminal + stderr).decode(errors="replace")
        if mode == "json":
            assert json.loads(stdout) == {"provider": "faux", "type": "oauth"}
            assert mode_checks == [("select", False), ("text", False), ("secret", False)], mode_checks
            assert b"\x1b" not in stdout + stderr + terminal
            assert all(json.loads(line) for line in stderr.splitlines())
        else:
            assert b"Signed in to faux using OAuth" in stdout
            assert b"Authentication method" in terminal and b"API key" in terminal and b"OAuth" in terminal
            if mode == "human":
                assert b"visible name" in terminal
    print(json.dumps({"mode": mode, "passed": True}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
