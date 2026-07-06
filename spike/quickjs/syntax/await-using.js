// `await using` — async explicit resource management.
async function main() {
  let disposed = false;
  { await using r = { [Symbol.asyncDispose]: async () => { disposed = true; } }; }
  if (!disposed) throw new Error("asyncDispose did not run");
  console.log("await-using: RUN-OK");
}
main().catch((e) => { console.log("await-using: RUN-FAIL " + e); throw e; });
