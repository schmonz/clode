#!/usr/bin/env python3
"""pty_run.py SECONDS [--send-hex HEX] -- cmd [args...]

Run a command under a real pseudo-terminal, optionally send a fixed keystroke
script (hex-encoded bytes) to it after a short delay, capture all of its
terminal output to our stdout, and stop after SECONDS (or when it exits),
killing it if needed.

Input is passed as --send-hex (e.g. 0303 for two Ctrl-C) rather than via our
stdin, so the harness never blocks waiting for EOF.

Dependency-free (stdlib pty/termios) and portable across macOS/Linux/NetBSD —
unlike script(1), whose flags and capture behaviour differ per platform. Used to
smoke-test the interactive TUI, which needs a tty on stdin/stdout to render.
"""
import os, pty, sys, select, time, signal, struct, fcntl, termios


def main():
    argv = sys.argv[1:]
    to_send = b''
    if len(argv) >= 2 and argv[1] == '--send-hex':
        to_send = bytes.fromhex(argv[2])
        argv = [argv[0]] + argv[3:]
    if len(argv) < 3 or argv[1] != '--':
        sys.exit("usage: pty_run.py SECONDS [--send-hex HEX] -- cmd [args...]")
    secs = float(argv[0])
    cmd = argv[2:]

    pid, fd = pty.fork()
    if pid == 0:                       # child: becomes the cmd, pty is its tty
        try:
            os.execvp(cmd[0], cmd)
        except Exception as e:
            sys.stderr.write("exec failed: %s\n" % e)
        os._exit(127)

    # parent: drive the pty master
    try:                               # give the TUI a sane window to render into
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    except Exception:
        pass

    out = sys.stdout.buffer
    start = time.time()
    sent = False
    acc = b''             # cumulative output, scanned for capability queries
    answered = set()      # query types already answered (answer each once)
    # (query-substring, answered-key, response a real terminal would send)
    PROBES = [
        (b'\x1b]11;?',  'osc11',  b'\x1b]11;rgb:0000/0000/0000\x07'),   # bg color (BEL)
        (b'\x1b]10;?',  'osc10',  b'\x1b]10;rgb:ffff/ffff/ffff\x07'),   # fg color (BEL)
        (b'\x1b[>0q',   'xtver',  b'\x1bP>|pty_run 0.1\x1b\\'),         # XTVERSION (DCS)
        (b'\x1b[>c',    'da2',    b'\x1b[>0;10;1c'),                    # secondary DA
        (b'\x1b[>0c',   'da2',    b'\x1b[>0;10;1c'),
        (b'\x1b[c',     'da1',    b'\x1b[?62;1;2;6;9;15;22c'),          # primary DA
        (b'\x1b[0c',    'da1',    b'\x1b[?62;1;2;6;9;15;22c'),
        (b'\x1b[5n',    'dsr5',   b'\x1b[0n'),                          # device status OK
        (b'\x1b[6n',    'dsr6',   b'\x1b[1;1R'),                        # cursor position
        (b'\x1b[?2031', 'm2031',  b''),                                 # theme-update mode (no reply)
    ]
    while True:
        if time.time() - start > secs:
            break
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(data); out.flush()
            acc += data
            reply = b''
            for needle, key, resp in PROBES:
                if needle in acc and key not in answered:
                    answered.add(key)
                    reply += resp
            if reply:
                try:
                    os.write(fd, reply)
                except OSError:
                    pass
        if not sent and to_send and time.time() - start > 1.5:
            try:
                os.write(fd, to_send)
            except OSError:
                pass
            sent = True
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                break
        except ChildProcessError:
            break

    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except OSError:
            break
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                break
        except ChildProcessError:
            break
        time.sleep(0.3)


if __name__ == '__main__':
    main()
