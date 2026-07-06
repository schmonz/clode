# Gate 3 — memory axis (darwin-arm64)

Bundle: /Users/schmonz/.cache/clode/2.1.198/cli.cjs (18441695 bytes).

## qjsc parse+compile (source -> bytecode, discarded)
```
$ /Users/schmonz/Documents/shared-trees/clode/spike/quickjs/vendor/quickjs-ng/build/qjsc -o /dev/null /Users/schmonz/.cache/clode/2.1.198/cli.cjs
exit=0
       15.49 real        15.09 user         0.19 sys
           280887296  maximum resident set size
```

## qjs run-from-source (crash at first missing API is expected evidence)
```
$ /Users/schmonz/Documents/shared-trees/clode/spike/quickjs/vendor/quickjs-ng/build/qjs /Users/schmonz/.cache/clode/2.1.198/cli.cjs
exit=1
       11.80 real        11.54 user         0.14 sys
           218431488  maximum resident set size
```

## control: qjs empty script
```
$ /Users/schmonz/Documents/shared-trees/clode/spike/quickjs/vendor/quickjs-ng/build/qjs -e 1
exit=0
        0.24 real         0.00 user         0.00 sys
             2490368  maximum resident set size
```

## standalone run-from-bytecode via qjs -c (crash expected)
```
$ /var/folders/y5/k8bh4xsj75g4j1n631f2gqz80000gp/T//qjsmem.61388/bundle-exe
exit=1
        0.44 real         0.09 user         0.01 sys
            84344832  maximum resident set size
```

## Reading

The three cases split cleanly around the mac68k-class ceiling (~64-128MB
usable RAM). Parse-from-source is far outside it: qjsc parse+compile peaks at
267.9MB (280,887,296 B) and qjs run-from-source (parse, start, crash at the
first missing Node API) at 208.3MB (218,431,488 B) — 2-4x over even the
generous 128MB end, against a 2.4MB (2,490,368 B) empty-script control. Run-
from-bytecode is a different story: the standalone executable produced by
`qjs -c cli.cjs -o exe` (a real 25.8MB Mach-O with the bundle's bytecode
embedded; it runs the same code and crashes at the same missing API, exit=1
in 0.44s) peaks at just 84,344,832 B — about 80.4MB, roughly 2.6x below run-
from-source and 3.3x below qjsc's compile pass. That is INSIDE the 64-128MB
ceiling: comfortably under 128MB, workable on a 96MB machine, though still
over a bare 64MB floor. So run-from-bytecode materially undercuts parse-from-
source — by ~134MB, not a marginal shave — because it skips holding and
parsing 18.4MB of source text entirely, and it is the load-bearing path for
the North Star: bytecode-embedded standalone executables are the only
measured mechanism that fits the ceiling, and the guest (NetBSD/qemu) runs
must measure this same `qjs -c` standalone case, not just the source paths.
Mechanism note, to spare future readers a wasted afternoon: `qjsc -o <file>`
in quickjs-ng 0.15.1 only ever emits C source (it never invokes a compiler or
linker; producing a binary from it needs a separate cc+link against
libqjs.a), whereas the qjs interpreter's own `-c/--compile FILE -o OUT` mode
emits a ready-to-run executable by embedding bytecode into a copy of itself
(`--exe` selects the base). The two are entirely separate features despite
the similar names; an earlier revision of this file mistook the former's
failure for "standalone unmeasurable" and wrongly concluded bytecode offered
only a modest saving.
