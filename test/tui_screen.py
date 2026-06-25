#!/usr/bin/env python3
"""tui_screen.py SECONDS [--send-hex HEX] [--then-hex HEX@DELAY] [--rows R --cols C] -- cmd [args...]

Run a TUI command under a pseudo-terminal with a REAL terminal emulator (pyte)
on the other end, so capability-query-gated apps (Claude Code's Ink TUI probes
DA/DSR/OSC/XTVERSION at startup and waits for answers) actually render. Prints
the final rendered screen to stdout for the test to assert on.

Unlike the dependency-free pty_run.py (raw byte capture + hand-rolled query
replies), this gives a true screen buffer. Requires `pyte` (test-only dep).

Exit 0 always; the caller inspects the printed screen.
"""
import os, pty, sys, select, time, signal, struct, fcntl, termios
import pyte


class RespondingScreen(pyte.Screen):
    """A pyte screen that queues the protocol-correct responses pyte generates
    (primary DA, device-status / cursor-position reports) so we can write them
    back to the application via the pty."""
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.outbox = b''

    def write_process_input(self, data):
        self.outbox += data.encode('latin-1', 'replace') if isinstance(data, str) else data


# Queries pyte doesn't answer (xterm extensions). A real terminal would; supply
# plausible responses so the TUI's startup negotiation completes.
EXTRA_PROBES = [
    (b'\x1b]11;?', 'osc11', b'\x1b]11;rgb:0000/0000/0000\x07'),   # background color
    (b'\x1b]10;?', 'osc10', b'\x1b]10;rgb:ffff/ffff/ffff\x07'),   # foreground color
    (b'\x1b[>0q',  'xtver', b'\x1bP>|pyte\x1b\\'),                # XTVERSION (DCS)
    (b'\x1b[>c',   'da2',   b'\x1b[>0;10;1c'),                    # secondary DA
    (b'\x1b[>0c',  'da2',   b'\x1b[>0;10;1c'),
]


def main():
    argv = sys.argv[1:]
    # Each send is (delay_seconds, bytes). --send-hex keeps its historical 1.5s
    # default; --then-hex HEX@DELAY adds further timed sends. Sending the submit
    # Enter as a SEPARATE later keystroke is what lets a slash command actually
    # submit: a batched "/doctor\r" is swallowed as a bracketed paste.
    sends = []
    rows, cols = 40, 100
    # parse leading options
    while len(argv) >= 2 and argv[1] in ('--send-hex', '--then-hex', '--rows', '--cols'):
        if argv[1] == '--send-hex':
            sends.append((1.5, bytes.fromhex(argv[2])))
        elif argv[1] == '--then-hex':
            spec = argv[2]
            hexpart, _, delaypart = spec.partition('@')
            sends.append((float(delaypart), bytes.fromhex(hexpart)))
        elif argv[1] == '--rows':
            rows = int(argv[2])
        elif argv[1] == '--cols':
            cols = int(argv[2])
        argv = [argv[0]] + argv[3:]
    sends.sort(key=lambda s: s[0])
    if len(argv) < 3 or argv[1] != '--':
        sys.exit("usage: tui_screen.py SECONDS [--send-hex HEX] [--then-hex HEX@DELAY] [--rows R --cols C] -- cmd ...")
    secs = float(argv[0])
    cmd = argv[2:]

    screen = RespondingScreen(cols, rows)
    stream = pyte.ByteStream(screen)

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(cmd[0], cmd)
        except Exception as e:
            sys.stderr.write("exec failed: %s\n" % e)
        os._exit(127)

    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass

    start = time.time()
    next_send = 0
    answered = set()
    seen = b''
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
            stream.feed(data)
            seen += data
            # flush pyte's protocol responses (DA / DSR)
            reply = screen.outbox
            screen.outbox = b''
            # plus xterm-extension responses pyte ignores
            for needle, key, resp in EXTRA_PROBES:
                if needle in seen and key not in answered:
                    answered.add(key)
                    reply += resp
            if reply:
                try:
                    os.write(fd, reply)
                except OSError:
                    pass
        while next_send < len(sends) and time.time() - start > sends[next_send][0]:
            try:
                os.write(fd, sends[next_send][1])
            except OSError:
                pass
            next_send += 1
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
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

    if os.environ.get('TUI_DEBUG'):
        sys.stderr.write("RAW bytes=%d answered=%s\n" % (len(seen), sorted(answered)))
        sys.stderr.write("RAW tail: %r\n" % seen[-160:])

    # print the rendered screen
    for line in screen.display:
        sys.stdout.write(line.rstrip() + "\n")


if __name__ == '__main__':
    main()
