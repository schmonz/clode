# Gate 3 — memory axis (darwin-arm64)

Bundle: /Users/schmonz/.cache/clode/2.1.198/cli.cjs (18441695 bytes).

## qjsc parse+compile (source -> bytecode, discarded)
```
$ /Users/schmonz/Documents/shared-trees/clode/spike/quickjs/vendor/quickjs-ng/build/qjsc -o /dev/null /Users/schmonz/.cache/clode/2.1.198/cli.cjs
exit=0
       15.51 real        15.09 user         0.06 sys
           262733824  maximum resident set size
```

## qjs run-from-source (crash at first missing API is expected evidence)
```
$ /Users/schmonz/Documents/shared-trees/clode/spike/quickjs/vendor/quickjs-ng/build/qjs /Users/schmonz/.cache/clode/2.1.198/cli.cjs
exit=1
       11.77 real        11.58 user         0.05 sys
           219201536  maximum resident set size
```

## control: qjs empty script
```
$ /Users/schmonz/Documents/shared-trees/clode/spike/quickjs/vendor/quickjs-ng/build/qjs -e 1
exit=0
        0.15 real         0.00 user         0.00 sys
             2539520  maximum resident set size
```

## standalone run-from-bytecode (crash expected)
```
$ /var/folders/y5/k8bh4xsj75g4j1n631f2gqz80000gp/T//qjsmem.60397/bundle-bin
exit=126
        0.00 real         0.00 user         0.00 sys
              933888  maximum resident set size
```

## Reading

Both real-parse paths blow well past a mac68k-class ceiling: qjsc parse+compile
peaks at ~250.6MB (262,733,824 B) and qjs run-from-source (parse-then-crash-on-
missing-API) peaks at ~209.0MB (219,201,536 B), against a ~2.4MB (2,539,520 B)
control — both are 85-100x the control and roughly 2-4x even the generous end
of a 64-128MB budget, so the 18.4MB bundle as shipped today is not viable on a
memory-constrained target via either path. The standalone (run-from-bytecode)
row is not usable evidence: this quickjs-ng build's `qjsc -o <file>` only ever
emits C source, never a linked binary — confirmed by inspecting `qjsc.c` (no
compiler/linker invocation) and by re-trying with a `cmake --install`'d qjsc,
which behaved identically — so the "exe" the script tries to run is actually a
C-source text file, and the exec attempt fails immediately (exit=126, ~0.9MB,
an artifact of the shell's failed `exec()` rather than a JS-engine
measurement). Producing a real standalone binary needs a separate `cc` compile
+ link against `libqjs.a` that this script doesn't perform. Absent that number
we can't directly measure how much run-from-bytecode undercuts parse-from-
source, but the two numbers in hand suggest the answer is "not enough to
matter for this ceiling": qjs run-from-source (209MB) is only ~16% below
qjsc's parse+compile (250MB) despite crashing early — before finishing bundle
initialization — which means most of the RSS goes into holding/parsing 18.4MB
of source text and building its AST/object graph rather than into running it.
A bytecode-embedded executable skips the text-parsing step, but still has to
deserialize that much bytecode into a live heap of comparable object count, so
it would likely shave some of this cost, not most of it. Getting under even
the optimistic 128MB end of the mac68k budget will require shrinking or
splitting the bundle, not just switching from source to bytecode.
