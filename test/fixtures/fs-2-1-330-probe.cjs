'use strict';
// Probe for test/node-shim-fs-2-1-330.test.cjs: the fs answers node-shim-differential found diverging at the
// 2.1.330 pin, printed as one JSON line (`FS330 {...}`) for node and quaude to be compared field by field.
// argv[2] is a fresh scratch directory.
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const out = {};
const err = (e) => (e ? { name: e.name, code: e.code, errno: e.errno, syscall: e.syscall, path: e.path === undefined ? null : rel(String(e.path)),
  message: String(e.message).split(root).join('<root>') } : null);
const rel = (p) => (typeof p === 'string' ? p.split(root).join('<root>') : p);
const sync = (f) => { try { const r = f(); return { ok: r === undefined ? 'undefined' : rel(r) }; } catch (e) { return { error: err(e) }; } };
const later = (f) => new Promise((res) => { try { Promise.resolve(f()).then((r) => res({ ok: r === undefined ? 'undefined' : 'value' }), (e) => res({ error: err(e) })); } catch (e) { res({ thrown: err(e) }); } });

fs.writeFileSync(path.join(root, 'file'), 'x');
fs.mkdirSync(path.join(root, 'dir/sub/deep'), { recursive: true });
fs.writeFileSync(path.join(root, 'dir/a'), '');
fs.writeFileSync(path.join(root, 'dir/sub/c'), '');
fs.writeFileSync(path.join(root, 'dir/sub/deep/e'), '');
fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
const P = (n) => path.join(root, n);

(async () => {
  // the mode reaches the create when fs.open is given NUMERIC flags (2.1.330's call; it made 0644)
  const C = fs.constants;
  await new Promise((res) => fs.open(P('made600'), C.O_WRONLY | C.O_APPEND | C.O_CREAT, 0o600, (e, fd) => {
    out.openMode = e ? err(e) : (fs.fstatSync(fd).mode & 0o777).toString(8);
    if (!e) fs.closeSync(fd);
    res();
  }));
  out.openModeOnDisk = (fs.statSync(P('made600')).mode & 0o777).toString(8);
  // utimesSync's errors are thrown, synchronously, as node's (it returned as if it had worked)
  for (const n of ['missing', 'dangling', 'file/x']) out[`utimesSync ${n}`] = sync(() => fs.utimesSync(P(n), 1000, 1000));
  // lutimesSync exists, follows no link, and throws node's lutime errors
  out.lutimesSyncType = typeof fs.lutimesSync;
  for (const n of ['missing', 'file/x', 'dangling', 'file']) out[`lutimesSync ${n}`] = sync(() => fs.lutimesSync(P(n), 1000, 1000));
  // readdir errors are a scandir's
  out['readdirSync missing'] = sync(() => fs.readdirSync(P('missing')));
  out['readdirSync file'] = sync(() => fs.readdirSync(P('file')));
  // recursive readdir is breadth-first (each directory's own order sorted here: the engine does not sort)
  out['readdirSync recursive'] = sync(() => fs.readdirSync(P('dir'), { recursive: true }).map((x) => x.split(path.sep).join('/')).sort((x, y) => x.split('/').length - y.split('/').length || (x < y ? -1 : 1)));
  // opendir: opendirSync's errors carry no path, the promise's do; recursive walks the whole tree
  out['opendirSync missing'] = sync(() => fs.opendirSync(P('missing')));
  out['opendirSync file'] = sync(() => fs.opendirSync(P('file')));
  out['promises.opendir missing'] = await later(() => fs.promises.opendir(P('missing')));
  const names = [];
  for await (const d of await fs.promises.opendir(P('dir'), { recursive: true })) names.push(path.relative(P('dir'), path.join(d.parentPath, d.name)).split(path.sep).join('/'));
  out['promises.opendir recursive'] = names.sort();
  // the JS realpath walk's errors: lstat for a missing component, stat for a dangling link; .native says realpath
  for (const n of ['missing', 'dangling', 'file/x']) {
    out[`realpathSync ${n}`] = sync(() => fs.realpathSync(P(n)));
    out[`realpathSync.native ${n}`] = sync(() => fs.realpathSync.native(P(n)));
    out[`realpath ${n}`] = await new Promise((res) => fs.realpath(P(n), (e) => res(e ? err(e) : 'ok')));
    out[`promises.realpath ${n}`] = await later(() => fs.promises.realpath(P(n)));
  }
  // a missing path argument is node's ERR_INVALID_ARG_TYPE
  out['promises.lstat()'] = await later(() => fs.promises.lstat());
  out['promises.mkdtemp()'] = await later(() => fs.promises.mkdtemp());
  out['mkdtempSync(42)'] = sync(() => fs.mkdtempSync(42));
  out['statSync()'] = sync(() => fs.statSync());
  console.log('FS330 ' + JSON.stringify(out));
})();
