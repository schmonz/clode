#!/usr/bin/env python3
# Haiku VM monitor helper. Screenshots + keys over HMP; ABSOLUTE clicks over QMP
# (HMP mouse_move is relative-only and cannot place the cursor at a pixel).
#   hmon.py shot <name>       -> /private/tmp/haiku-vm/<name>.png
#   hmon.py click <x> <y>     -> absolute move + left click at screen pixel x,y
#   hmon.py move <x> <y>      -> absolute move only
#   hmon.py type "text"       -> sendkey each char
#   hmon.py key <k> [..]      -> sendkey named keys (ret, spc, ...)
#   hmon.py cmd "<hmp>"       -> raw HMP, print reply
import socket, time, sys, subprocess, json

DIR = '/private/tmp/haiku-vm'
MON = f'{DIR}/mon.sock'
QMP = f'{DIR}/qmp.sock'
W, H = 1280, 800
ABS = 32767

def hmp(cmds, wait=0.5):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(MON)
    time.sleep(0.3); s.recv(65536)
    if isinstance(cmds, str): cmds = [cmds]
    out = ''
    for c in cmds:
        s.sendall((c + '\n').encode()); time.sleep(wait)
        try: out += s.recv(200000).decode(errors='replace')
        except: pass
    s.close(); return out.replace('\r', '')

def qmp(events):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(QMP)
    time.sleep(0.2); s.recv(65536)
    s.sendall(b'{"execute":"qmp_capabilities"}\n'); time.sleep(0.2); s.recv(65536)
    for e in events:
        s.sendall((json.dumps(e) + '\n').encode()); time.sleep(0.15)
        try: s.recv(65536)
        except: pass
    s.close()

def abs_move(x, y):
    ax, ay = int(x * ABS / W), int(y * ABS / H)
    qmp([{"execute": "input-send-event", "arguments": {"events": [
        {"type": "abs", "data": {"axis": "x", "value": ax}},
        {"type": "abs", "data": {"axis": "y", "value": ay}}]}}])

def click(x, y):
    abs_move(x, y); time.sleep(0.2)
    for down in (True, False):
        qmp([{"execute": "input-send-event", "arguments": {"events": [
            {"type": "btn", "data": {"down": down, "button": "left"}}]}}])
        time.sleep(0.1)

SHIFT = {'_':'minus',':':'semicolon','"':'apostrophe','<':'comma','>':'dot','?':'slash',
         '|':'backslash','~':'grave_accent','!':'1','@':'2','#':'3','$':'4','%':'5','^':'6',
         '&':'7','*':'8','(':'9',')':'0','+':'equal','{':'bracket_left','}':'bracket_right'}
PLAIN = {' ':'spc','-':'minus','=':'equal',';':'semicolon',"'":'apostrophe',',':'comma','.':'dot',
         '/':'slash','\\':'backslash','`':'grave_accent','[':'bracket_left',']':'bracket_right','\n':'ret'}

def keytok(ch):
    if ch.isalpha(): return ch.lower(), ch.isupper()
    if ch.isdigit(): return ch, False
    if ch in SHIFT: return SHIFT[ch], True
    if ch in PLAIN: return PLAIN[ch], False
    return None, False

def type_text(text):
    seq = []
    for ch in text:
        tok, shift = keytok(ch)
        if tok: seq.append('sendkey ' + ('shift-'+tok if shift else tok))
    hmp(seq, wait=0.06)

def shot(name):
    hmp(f'screendump {DIR}/{name}.ppm', wait=1.5)
    subprocess.run(['python3','-c',
        f"from PIL import Image; Image.open('{DIR}/{name}.ppm').save('{DIR}/{name}.png')"])
    print(f'{DIR}/{name}.png')

a = sys.argv
if   a[1] == 'shot':  shot(a[2] if len(a) > 2 else 'shot')
elif a[1] == 'click': click(int(a[2]), int(a[3]))
elif a[1] == 'move':  abs_move(int(a[2]), int(a[3]))
elif a[1] == 'type':  type_text(a[2])
elif a[1] == 'key':   hmp(['sendkey ' + k for k in a[2:]], wait=0.15)
elif a[1] == 'cmd':   print(hmp(a[2], wait=1.0))
