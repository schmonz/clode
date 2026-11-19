// A node:test reporter that writes what a CI job's tests did, one JSON line per test: the record
// test/build-gates/tool-coverage-gates.test.cjs reads (CLODE_CELL_JOB=<job> CLODE_CELL_RAN=<dir>)
// to say which tool x mode x engine cells that job actually drove. A cell is driven only where a
// job runs its driver's test AND the test passes; a test that merely exists, or skips, drives
// nothing (observability plan Task 1).
//
// Used beside the human-readable reporter, never instead of it:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./test/cell-reporter.mjs --test-reporter-destination="$CELLS/<step>.jsonl" FILES
//
// One line per finished test: { type: 'test:pass' | 'test:fail', file, line, name, nesting,
// skip?, todo? }. `line` is the line of the test(...) call, which is how the gate names a test;
// `skip`/`todo` carry the reason (node:test reports a skipped test as test:pass).
export default async function* cellReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data || {};
    const rec = { type: event.type, file: d.file, line: d.line, name: d.name, nesting: d.nesting };
    if (d.skip !== undefined) rec.skip = d.skip === true ? '' : String(d.skip);
    if (d.todo !== undefined) rec.todo = d.todo === true ? '' : String(d.todo);
    yield `${JSON.stringify(rec)}\n`;
  }
}
