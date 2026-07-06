// Regex features are the untranspilable floor (esbuild cannot lower these).
if (!/(?<=x)y/.test("xy")) throw new Error("lookbehind");
if (/(?<n>\d+)/.exec("a42").groups.n !== "42") throw new Error("named groups");
if (!Array.isArray(/x/d.exec("x").indices)) throw new Error("d flag indices");
console.log("regex-features: RUN-OK");
