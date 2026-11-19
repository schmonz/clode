'use strict';
// The divergences from node that the differential TOLERATES today, each by cause, each named in
// BACKLOG.md under BACKLOG_HEADING. A cause covers a judged field of a case when its `api` matches
// the case's API, its `id` (if any) the case id, and its `leaf` (if any) the field (`r.error.syscall`,
// `after.new.mode`). A case is tolerated only when EVERY diverging field of it is covered, so a new
// difference inside a known case still fails. A cause that covers nothing is itself a finding: fixed
// things leave this list in the commit that fixes them. `only` names the platforms a cause diverges
// on (its carve calls the API there, or the defect is that platform's); elsewhere it is not expected.
const BACKLOG_HEADING = 'node-shim against node: what the behaviour differential names (2026-11-19)';

const E = '^r\\.error\\.';   // any field of a thrown error
const CAUSES = [
  { cause: 'DIFF-WRITESTREAM-THROWS', api: '^fs\\.createWriteStream$', leaf: '^r\\.(end|error\\.)' },
  { cause: 'DIFF-WRITESTREAM-FD', api: '^fs\\.createWriteStream$', id: 'fd:fd:', leaf: '^after\\.' },
  { cause: 'DIFF-MKDIR-RECURSIVE', api: '^fs(/promises)?\\.(mkdirSync|mkdir)$' },
  { cause: 'DIFF-ASYNC-ERRORS', api: '^fs(/promises)?\\.(readFile|link|utimes|lutimes|statfs)$', leaf: E },
  { cause: 'DIFF-ASYNC-ERRORS', api: '^fs\\.createReadStream$', leaf: '^r\\.end\\.error\\.' },
  { cause: 'DIFF-SCANDIR', api: '^fs(/promises)?\\.(readdirSync|readdir|opendir)$', leaf: '^r\\.error\\.(message|syscall)$' },
  { cause: 'DIFF-ENCODINGS', api: '^fs(/promises)?\\.(readlinkSync|readlink|readdir|readFileSync)$', id: '"(buffer|ascii)"', leaf: '^r($|\\.)' },
  { cause: 'DIFF-FD-PRIMITIVES', api: '^fs\\.(fchmod|fchmodSync|fsyncSync|ftruncateSync)$' },
  { cause: 'DIFF-READSYNC-RANGE', api: '^fs\\.readSync$', leaf: E },
  { cause: 'DIFF-REALPATH-SYSCALL', api: '^fs\\.realpathSync$', leaf: '^r\\.error\\.(message|syscall)$' },
  { cause: 'DIFF-RM', api: '^fs(/promises)?\\.(rmSync|rm)$' },
  { cause: 'DIFF-MKDTEMP-ERROR', api: '^fs(/promises)?\\.(mkdtempSync|mkdtemp)$', leaf: E },
  { cause: 'DIFF-COPYFILE', api: '^fs/promises\\.copyFile$', leaf: E },
  { cause: 'DIFF-STATFS-CLASS', api: '^fs/promises\\.statfs$', leaf: '^r\\.ctor$' },
  { cause: 'DIFF-ARG-VALIDATION', api: '^(fs/promises\\.(unlink|readFile)|fs\\.writeFileSync|path\\.dirname|util\\.formatWithOptions)$',
    id: '(\\(\\)|\\(<[^>]*>\\)|\\((undefined|null)[,)])' },
  { cause: 'DIFF-MISSING-MEMBERS', api: '^(fs\\.promises|fs/promises\\.constants|path\\.(win32|posix)|util\\.types)$' },
  { cause: 'DIFF-STDIO-CLASS', api: '^process\\.(stdout|stderr|env)$', leaf: '^r\\.ctor$' },
  { cause: 'DIFF-ZLIB', api: '^zlib\\.' },
  { cause: 'DIFF-OS-MEMORY-RELEASE', api: '^os\\.(totalmem|freemem|release|version)$' },
  { cause: 'DIFF-NET-SERVER', api: '^net\\.createServer$' },
  { cause: 'DIFF-PATH-DOTDOT', api: '^path\\.(parse|extname)$' },
  { cause: 'DIFF-ISATTY-DEVNULL', api: '^tty\\.isatty$', id: '\\(0\\)' },
  { cause: 'DIFF-UTIL-FORMAT', api: '^util\\.(format|inspect)$' },
  { cause: 'DIFF-PROCFS-EMPTY', api: '^fs\\.readFileSync$', id: '"/proc/', only: ['linux'] },
  { cause: 'DIFF-STATFS-SYNC', api: '^fs\\.statfsSync$', only: ['linux'] },
];

function matches(k, c, leaf) {
  if (!c) return false;
  if (!new RegExp(k.api).test(c.api)) return false;
  if (k.id && !new RegExp(k.id).test(c.id)) return false;
  if (k.leaf && !new RegExp(k.leaf).test(leaf)) return false;
  return true;
}

module.exports = { BACKLOG_HEADING, CAUSES, matches };
