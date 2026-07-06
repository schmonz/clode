// Explicit resource management: `using` declaration (the known likely wall).
class R { [Symbol.dispose]() { globalThis.__disposed = true; } }
{ using r = new R(); }
if (!globalThis.__disposed) throw new Error("dispose did not run");
console.log("using: RUN-OK");
