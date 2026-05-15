# OMP compatibility

`pi-model-selector` supports both Pi and OMP. OMP loads Pi extensions through a Pi-compatibility mirror instead of importing the extension source in place.

## How the OMP mirror works

When OMP discovers a Pi-style extension, it mirrors the extension's source files into a temporary directory similar to:

```text
$TMPDIR/omp-legacy-pi-file/<extension-hash>/<file-hash>.ts
```

During that mirroring step, OMP rewrites literal Pi package specifiers to their OMP package equivalents. For example:

```ts
await import("@mariozechner/pi-coding-agent");
await import("@mariozechner/pi-tui");
```

are rewritten by OMP to load the corresponding `@oh-my-pi/*` packages from the mirrored file.

## Rules for this extension

- Import Pi/SDK packages with literal `@mariozechner/*` specifiers in runtime code. OMP rewrites them; Pi loads them directly.
- Do not probe or import `@oh-my-pi/*` directly from the extension. That can re-enter OMP's SDK import while the extension loader is still resolving the mirror and can fail with `RangeError: Maximum call stack size exceeded`.
- Do not rely on `import.meta.url`, module singleton identity, or source-relative filesystem paths when code may run under OMP. In OMP, the executing module URL points at the temporary mirror, not the editable source tree.
- Runtime-specific persistent files should use the runtime config directory (`.pi` for Pi, `.omp` for OMP), not paths derived from the mirrored module location.

The regression test in `tests/adapter-omp-loader-compat.test.ts` protects the import-specifier rule.
