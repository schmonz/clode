class C { static x = 1; static { C.y = C.x + 1; } }
if (C.y !== 2) throw new Error("static block did not run");
console.log("static-blocks: RUN-OK");
