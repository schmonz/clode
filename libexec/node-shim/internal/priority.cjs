'use strict';
// os.getPriority / os.setPriority, as node answers them, on every platform: a real value everywhere, never a constant
// and never a platform gap.
//
// tjs exposes no getpriority/setpriority and no GetPriorityClass/SetPriorityClass (its tjs.* and tjs.system.* hold no
// such member), so both ask what the operating system already publishes:
//   POSIX   /proc/<pid>/stat where there is one (see procNice), else `ps -o nice= -p <pid>` to read a nice value and
//           `renice <priority> -p <pid>` to set one (the absolute form, which BSD, macOS, util-linux and busybox renice
//           all read as absolute; `-n` is an increment on some and absolute on others, so it is not used). The pattern
//           is process.cjs's unixGetuid falling back to `id -u`.
//   Windows Windows PowerShell (powershell.exe ships with every supported Windows), reading and writing the process's
//           PriorityClass. Node there answers from libuv's uv_os_getpriority/uv_os_setpriority (src/win/util.c), which
//           map the six priority classes to nice-shaped numbers; WIN_CLASSES below is that mapping, both directions.
// These used to answer a constant 0 and do nothing, so the 2.1.283 bundle's background daemon, which lowers its own
// priority by 5 off Windows (its one call site: `if (platform !== "windows") try { setPriority(0, Math.min(getPriority(0)
// + 5, 19)) } catch {}`), silently ran at full priority. Found by node-shim-oracle-darwin, whose runner runs at nice -10;
// judged under a deliberate nice by test/node-shim-os-priority.test.cjs and the differential, and the Windows branch by
// test/node-shim-os-priority-win32.test.cjs (injected PowerShell; UNMEASURED on a real Windows box).
//
// Arguments are validated as node's validateInt32 does; a failure is node's SystemError (ERR_SYSTEM_ERROR, info { errno,
// code, message, syscall: uv_os_getpriority / uv_os_setpriority }). Without the utility (a PATH that lacks it) the call
// THROWS that SystemError with ENOSYS, naming the utility: never a fake answer.
//
// Everything that touches the system is INJECTED (makePriority's deps), so this file is loadable by host node and the
// Windows branch is testable off Windows.

function argTypeError(name, v) {
  const e = new TypeError(`The "${name}" argument must be of type number. Received ${v === null ? 'null' : `type ${typeof v} (${String(v)})`}`);
  e.code = 'ERR_INVALID_ARG_TYPE';
  return e;
}
function validateInt32(v, name, min = -2147483648, max = 2147483647) {
  if (typeof v !== 'number') throw argTypeError(name, v);
  if (!Number.isInteger(v)) { const e = new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${v}`); e.code = 'ERR_OUT_OF_RANGE'; throw e; }
  if (v < min || v > max) { const e = new RangeError(`The value of "${name}" is out of range. It must be >= ${min} && <= ${max}. Received ${v}`); e.code = 'ERR_OUT_OF_RANGE'; throw e; }
}
const UV_TEXT = { ESRCH: 'no such process', EACCES: 'permission denied', EPERM: 'operation not permitted', ENOSYS: 'function not implemented', EINVAL: 'invalid argument' };
class NodeError extends Error {}

// libuv's Windows mapping (src/win/util.c). GET: the class names a number. SET: a number picks the class whose band it
// falls in, `priority < next band's floor`, so -20..-15 REALTIME, -14..-8 HIGH, -7..-1 ABOVE_NORMAL, 0..9 NORMAL,
// 10..18 BELOW_NORMAL, 19 IDLE. PowerShell spells the classes as System.Diagnostics.ProcessPriorityClass does.
const WIN_CLASSES = [
  { name: 'RealTime', v: -20 }, { name: 'High', v: -14 }, { name: 'AboveNormal', v: -7 },
  { name: 'Normal', v: 0 }, { name: 'BelowNormal', v: 10 }, { name: 'Idle', v: 19 },
];
function winClassFor(priority) {
  for (let i = WIN_CLASSES.length - 1; i >= 0; i--) if (priority >= WIN_CLASSES[i].v) return WIN_CLASSES[i].name;
  return WIN_CLASSES[0].name;
}

function makePriority(deps) {
  const { platform, pid: selfPidOf, run, readProcStat, errno } = deps;
  function systemError(syscall, code, detail) {
    const n = errno && typeof errno[code] === 'number' ? -errno[code] : undefined;
    const text = UV_TEXT[code] || code;
    // node's SystemError is an instance of its internal class NodeError (constructor.name), named 'SystemError'
    const e = new NodeError(`A system error occurred: ${syscall} returned ${code} (${text})${detail ? `: ${detail}` : ''}`);
    e.name = 'SystemError';
    e.code = 'ERR_SYSTEM_ERROR';
    e.info = { errno: n, code, message: text, syscall };
    e.errno = n;
    e.syscall = syscall;
    return e;
  }
  const selfPid = (pid) => (pid === 0 ? selfPidOf() : pid);

  // Where /proc/<pid>/stat exists (Linux), its 19th field IS the nice value, read with no subprocess; that comes first
  // because busybox's ps (the alpine images) has no -p, so ps cannot answer there. A pid with no /proc/<pid> is no
  // process. Elsewhere, ps. readProcStat(pid): undefined = no /proc here, null = no such pid, else the file's text.
  function procNice(pid) {
    const text = readProcStat(pid);
    if (text === undefined || text === null) return text;
    // pid (comm) state ppid ...: comm may hold spaces and parens, so split after the LAST ')'
    const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const v = parseInt(rest[19 - 3], 10);
    return Number.isFinite(v) ? v : undefined;
  }

  // Windows. OpenProcess on a pid that is no process fails with ERROR_INVALID_PARAMETER, which libuv translates to
  // EINVAL (not ESRCH, as POSIX says); a process this user may not open is ERROR_ACCESS_DENIED, which is EPERM.
  function powershell(syscall, script) {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (r.missing) throw systemError(syscall, 'ENOSYS', r.missing);
    if (r.status === 0) return r.stdout.trim();
    const t = r.stderr;
    if (/Cannot find a process/i.test(t)) throw systemError(syscall, 'EINVAL');
    if (/Access is denied|denied/i.test(t)) throw systemError(syscall, 'EPERM');
    throw systemError(syscall, 'ENOSYS', `powershell exited ${r.status}: ${t.trim()}`);
  }
  const psProcess = (pid) => `(Get-Process -Id ${pid} -ErrorAction Stop)`;

  function getPriority(pid) {
    if (pid === undefined) pid = 0; else validateInt32(pid, 'pid');
    if (platform() === 'win32') {
      const name = powershell('uv_os_getpriority', `${psProcess(selfPid(pid))}.PriorityClass`);
      const c = WIN_CLASSES.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (c) return c.v;
      throw systemError('uv_os_getpriority', 'ENOSYS', `powershell printed no priority class: ${JSON.stringify(name)}`);
    }
    const proc = procNice(selfPid(pid));
    if (proc === null) throw systemError('uv_os_getpriority', 'ESRCH');
    if (proc !== undefined) return proc;
    const r = run('ps', ['-o', 'nice=', '-p', String(selfPid(pid))]);
    if (r.missing) throw systemError('uv_os_getpriority', 'ENOSYS', r.missing);
    const v = r.status === 0 ? parseInt(r.stdout.trim(), 10) : NaN;
    if (Number.isFinite(v)) return v;
    // ps exits non-zero (or prints nothing) for a pid that is no process, and for one too large to be one
    if (r.status !== 0 || r.stdout.trim() === '') throw systemError('uv_os_getpriority', 'ESRCH');
    throw systemError('uv_os_getpriority', 'ENOSYS', `ps printed no nice value: ${JSON.stringify(r.stdout.trim())}`);
  }

  function setPriority(pid, priority) {
    if (priority === undefined) { priority = pid; pid = 0; }
    validateInt32(pid, 'pid');
    validateInt32(priority, 'priority', -20, 19);
    if (platform() === 'win32') {
      powershell('uv_os_setpriority', `${psProcess(selfPid(pid))}.PriorityClass = '${winClassFor(priority)}'`);
      return;
    }
    const r = run('renice', [String(priority), '-p', String(selfPid(pid))]);
    if (r.missing) throw systemError('uv_os_setpriority', 'ENOSYS', r.missing);
    if (r.status === 0) return;
    const t = r.stderr;
    const code = /Permission denied/i.test(t) ? 'EACCES' : /not permitted/i.test(t) ? 'EPERM'
      : /No such process|too large|does not exist/i.test(t) ? 'ESRCH' : null;
    if (code) throw systemError('uv_os_setpriority', code);
    throw systemError('uv_os_setpriority', 'EINVAL', `renice exited ${r.status}: ${t.trim()}`);
  }
  return { getPriority, setPriority };
}

module.exports = { makePriority, WIN_CLASSES, winClassFor };
