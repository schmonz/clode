# Gate 2 — capability probe (darwin-arm64 dev machine)

## node (control)
```
PROBE global.fetch OK
PROBE global.crypto OK
PROBE global.TextEncoder OK
PROBE global.TextDecoder OK
PROBE global.URL OK
PROBE global.URLSearchParams OK
PROBE global.AbortController OK
PROBE global.WebSocket OK
PROBE global.Worker ABSENT
PROBE global.queueMicrotask OK
PROBE global.structuredClone OK
PROBE global.performance OK
PROBE global.setTimeout OK
PROBE global.ReadableStream OK
PROBE global.Blob OK
PROBE runtime.tjs ABSENT
PROBE runtime.node OK 24.18.0
PROBE runtime.qjs-std ABSENT
PROBE exercise.endianness OK le=true be=true f64=true
PROBE exercise.sha256-kat OK e3b0c44298fc
PROBE exercise.fileread OK noent-ok
PROBE exercise.spawn OK
PROBE exercise.fetch-tls OK status=200 body=2.1.193
PROBE exercise.tty-raw ABSENT process.stdin.setRawMode
PROBE-SUMMARY ok=20 fail=0 absent=4
```

## tjs
```
PROBE global.fetch OK
PROBE global.crypto OK
PROBE global.TextEncoder OK
PROBE global.TextDecoder OK
PROBE global.URL OK
PROBE global.URLSearchParams OK
PROBE global.AbortController OK
PROBE global.WebSocket OK
PROBE global.Worker OK
PROBE global.queueMicrotask OK
PROBE global.structuredClone OK
PROBE global.performance OK
PROBE global.setTimeout OK
PROBE global.ReadableStream OK
PROBE global.Blob OK
PROBE runtime.tjs OK 26.6.0
PROBE runtime.node ABSENT
PROBE runtime.qjs-std ABSENT
PROBE exercise.endianness OK le=true be=true f64=true
PROBE exercise.sha256-kat OK e3b0c44298fc
PROBE exercise.fileread OK noent-ok
PROBE exercise.spawn OK {"exit_status":0,"term_signal":null}
PROBE exercise.fetch-tls OK status=200 body=2.1.193
PROBE exercise.tty-raw OK tjs.stdin.setRawMode
PROBE-SUMMARY ok=22 fail=0 absent=2
```

## qjs
```
PROBE global.fetch ABSENT
PROBE global.crypto ABSENT
PROBE global.TextEncoder ABSENT
PROBE global.TextDecoder ABSENT
PROBE global.URL ABSENT
PROBE global.URLSearchParams ABSENT
PROBE global.AbortController ABSENT
PROBE global.WebSocket ABSENT
PROBE global.Worker ABSENT
PROBE global.queueMicrotask OK
PROBE global.structuredClone ABSENT
PROBE global.performance OK
PROBE global.setTimeout ABSENT
PROBE global.ReadableStream ABSENT
PROBE global.Blob ABSENT
PROBE runtime.tjs ABSENT
PROBE runtime.node ABSENT
PROBE runtime.qjs-std ABSENT
PROBE exercise.endianness OK le=true be=true f64=true
PROBE exercise.sha256-kat ABSENT no crypto.subtle
PROBE exercise.fileread ABSENT no fs API found
PROBE exercise.spawn ABSENT no spawn API found
PROBE exercise.fetch-tls ABSENT no fetch
PROBE exercise.tty-raw ABSENT no tty API found
PROBE-SUMMARY ok=3 fail=0 absent=21
```
