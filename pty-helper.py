#!/usr/bin/env python3 -u
"""
PTY helper: spawns a command in a real pseudo-terminal.
Node.js talks to this script via stdin/stdout (pipes),
and this script relays to/from the PTY using threads.
The PTY master is set to raw mode so keystrokes pass through unmodified.
"""

import sys
import os
import pty
import signal
import struct
import fcntl
import termios
import threading
import time
import tty

def main():
    if len(sys.argv) < 2:
        print("Usage: pty-helper.py <command> [args...]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[1:]

    # Create a PTY
    master_fd, slave_fd = pty.openpty()

    # Set terminal size — use cols/rows from env if provided, else default 80x24
    cols = int(os.environ.get("PTY_COLS", "80"))
    rows = int(os.environ.get("PTY_ROWS", "24"))
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    # Set master to raw mode so input passes through unmodified
    # This ensures \r from the browser reaches Claude Code as-is
    attrs = termios.tcgetattr(master_fd)
    # Disable input processing (ICRNL converts \r to \n, we don't want that)
    attrs[0] = attrs[0] & ~(termios.ICRNL | termios.INLCR | termios.IGNCR)
    # Disable output processing
    attrs[1] = attrs[1] & ~termios.OPOST
    # Disable canonical mode and echo on master
    attrs[3] = attrs[3] & ~(termios.ICANON | termios.ECHO)
    termios.tcsetattr(master_fd, termios.TCSANOW, attrs)

    pid = os.fork()
    if pid == 0:
        # Child process
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        os.environ["TERM"] = "xterm-256color"
        os.execvp(cmd, args)
        sys.exit(1)
    else:
        # Parent process
        os.close(slave_fd)

        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()
        alive = True

        # Thread: PTY master -> stdout (to Node)
        def pty_to_stdout():
            nonlocal alive
            while alive:
                try:
                    data = os.read(master_fd, 16384)
                    if not data:
                        break
                    view = memoryview(data)
                    written = 0
                    while written < len(data):
                        n = os.write(stdout_fd, view[written:])
                        written += n
                except OSError:
                    break
            alive = False

        # Thread: stdin (from Node) -> PTY master
        def stdin_to_pty():
            nonlocal alive
            while alive:
                try:
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        break
                    os.write(master_fd, data)
                except OSError:
                    break
            alive = False

        t1 = threading.Thread(target=pty_to_stdout, daemon=True)
        t2 = threading.Thread(target=stdin_to_pty, daemon=True)
        t1.start()
        t2.start()

        # Wait for child to exit
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0

        alive = False
        time.sleep(0.2)

        # Drain remaining output
        try:
            while True:
                data = os.read(master_fd, 16384)
                if not data:
                    break
                os.write(stdout_fd, data)
        except OSError:
            pass

        try:
            os.close(master_fd)
        except OSError:
            pass

        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
        sys.exit(code)

if __name__ == "__main__":
    main()
