# OMP compatibility

`pi-model-selector` supports these current host families:

- Pi 0.84.1 through `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (Node.js 22.19 or newer).
- OMP 17.2.12 through its `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` compatibility surface (Bun as required by OMP).

Legacy Pi releases published under `@mariozechner/*` are not supported.

## How OMP resolves current Pi imports

OMP 17.2.12's extension loader (`src/extensibility/extensions/loader.ts` in `@oh-my-pi/pi-coding-agent`) installs a specifier shim and loads every extension module through it, so we never rewrite imports ourselves. Specifically, the loader calls `installLegacyPiSpecifierShim()` at startup and imports each extension entry through `loadLegacyPiModule()`; both live in `src/extensibility/plugins/legacy-pi-compat.ts`. The shim matches package specifiers against the filter `^@(oh-my-pi|mariozechner|earendil-works)/pi-(coding-agent|tui)$`, remaps them to the canonical `@oh-my-pi` scope, and resolves them against the host-bundled modules inside the OMP binary.

That means literal imports such as:

```ts
await import("@earendil-works/pi-coding-agent");
await import("@earendil-works/pi-tui");
```

resolve directly under Pi and resolve to OMP's canonical in-process compatibility modules under OMP. This keeps one host extension registry and does not require a separate OMP entry point or direct `@oh-my-pi/*` imports in extension source.

`scripts/omp-compat-check.ts` executes this guarantee: when run under Bun on a machine with OMP installed, it loads `src/adapter.ts` through the real `installLegacyPiSpecifierShim()` plus `loadLegacyPiModule()` path and asserts both imports resolve to OMP host modules and that OMP mode is detected. It exits `SKIP` when OMP is absent, so CI without OMP stays green. `tests/omp-loader-executable.test.ts` runs that script from the vitest suite when Bun is available.

## Dual-runtime rules

- Use literal `@earendil-works/pi-*` specifiers for SDK imports. Do not import `@oh-my-pi/*` or deprecated `@mariozechner/pi-*` host packages directly.
- Avoid relative dynamic imports in runtime code. Static relative source imports remain supported.
- Use the host's exported `CONFIG_DIR_NAME` and `getAgentDir()` values for persistent state and credentials. They resolve to Pi's `.pi` locations or OMP's configured `.omp` locations.
- Current Pi exposes `ExtensionContext.mode` and `isProjectTrusted()`. OMP 17.2.12 does not, so compatibility checks enforce these APIs when present and fall back to OMP's `hasUI` and existing project-config behavior otherwise.
- Current Pi credentials are detected through public `ModelRegistry` methods. OMP's structural `authStorage` API and SQLite credential fallback remain supported for usage reporting.
- OMP model changes may update its default model role. The `preserveDefaultModel` setting retains the role around selector-driven changes.

`tests/adapter-omp-loader-compat.test.ts` protects package specifiers and the relative dynamic-import rule. The OMP-specific suites cover default-role restoration, usage conversion, provider filtering, and SQLite auth behavior.
