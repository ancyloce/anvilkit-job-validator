# anvilkit-job-validator

The trusted validator Job of the component workflow (DD-04 in
`docs/architecture/components.md` of `anvilkit-services`, delivery.md P10):
one reviewed complete source in, an npm tarball, declarations, one browser
ES module and separate CSS/resources out, and an independent certification
that binds their exact digests. Candidate code is data on this side: the
trusted process reads it, hashes it, hands it to bounded child processes,
and never imports it.

## What it does

| Stage | Code | What is established |
|---|---|---|
| Complete source (P10a) | `src/source.ts` | The inventory is walked and hashed by trusted code (sorted normalized paths, actual bytes); the candidate's `component.json` declaration (entry, styles, resources, usage, editable fields) is checked against it; symbolic links, special and hard-linked files, case aliases, escapes, build configuration, lifecycle scripts, `node_modules` and dependencies outside the profile are refused; package and dependency names must be valid for a new registry package (`validate-npm-package-name`, no legacy names or special characters) and versions exact (`node-semver` strict parse whose canonical form is the input: no `v`, whitespace, build metadata, leading zeros or ranges; nothing is coerced or cleaned); the result satisfies `contracts/components` `sourceManifest`. |
| Protected build (P10b) | `src/build.ts`, `src/build-worker.ts`, `src/tarball.ts` | Rollup with the TypeScript plugin, configured only from the profiles and this code (a trusted `tsconfig` in the work directory): one ES chunk importing only the Host ABI's externals, declarations under `dist/types`, stylesheets and resources copied byte for byte, the published `package.json` generated here (exact peer dependencies, no scripts, `anvilkit` metadata binding source and profile digests), and a reproducible gzipped tarball in npm layout (`package/`, fixed mtime, no owner) whose inventory is read back from its own bytes. At Rollup's resolve/load boundary only the inventoried `src/**` modules of the staged copy are loadable, each verified against its inventoried digest: absolute ids, relative ids that escape `src/`, virtual ids and any other byte on disk are refused, so the same source bytes and profiles build the same module whatever else changed; the externals' type declarations reach the compiler from this package's locked install only. |
| Independent Validator (P10c) | `src/validate.ts`, `fixtures/host/` | From the source read, the build's files and the exact profiles: the source contract and the toolchain re-established, the tarball's inventory, the module's imports and exports parsed from its bytes (`es-module-lexer`), inlined-runtime markers, declarations, CSS/resources with every reference parsed by `css-tree` (`url()`, `src()`, string URLs in `image-set()`, and `url()`/references inside custom properties and `var()` fallbacks, and string- and url-form `@import`; identifiers decoded, relative, inside the package, shipped and declared; parse errors refused — the browser never re-scans CSS text, it reuses this parsed list), the protected fixtures before and after use, then the SSR render (`fixtures/host/ssr.mjs`: a trusted harness that never imports the candidate spawns a render child which imports the candidate and renders it through the component's own `render` and through Puck's `Render` with react-dom/server; the child writes only the two rendered HTML strings to files whose paths it receives on stdin before the candidate is imported (through an `fs` binding it cannot reassign), and the harness — which never imports the candidate — reads those files and is the sole author of the verdict: each render present, non-empty and carrying the declared texts, and the output digests. A render that throws leaves no HTML, and a candidate that poisons `JSON.stringify` or `process.stdout.write` after import cannot rewrite evidence it never wrote and whose path it never saw, so an actual SSR failure is never certified) and the browser host (`fixtures/host/browser/`: a page whose import map serves one React, one ReactDOM and one Puck; Playwright's Chromium headless shell, every request answered by the worker through Playwright's interception on a synthetic origin — no socket, since the P09 candidate seccomp profile admits AF_UNIX only). In the browser everything decisive is observed from outside the page's main world, which the candidate shares with the host script: the DOM and the CSSOM read in an isolated world by the protected `observer.js` (rendered elements and texts, each declared stylesheet compared with a fresh parse of the shipped bytes, its matching rules confirmed to take effect in the browser's computed style — not merely to load and match a selector — and its resources decoded), Playwright's request log (only the host bundles and the module load as scripts; every request is one the package accounts for), real input for the interaction, and a re-render through a handle to the host's frozen control object captured before the candidate module is imported, with a value only the worker knows, and a real click that must advance the fixed Hero's defined click-count (`data-clicks`) — a candidate that renders nothing and fabricates a success report on `window`, or whose click makes no state transition, fails. Exit codes and page reports are data; the verdict comes from what was observed. |
| Job entrypoint (P10d) | `src/job.ts` | Reads the launch envelope, waits for the execution scope from the access sidecar's trusted socket, refuses a configuration that disables a mandatory check, runs the chain on the reviewed fixed source, uploads npm/browser/css/evidence through the sidecar's transfer route only under a complete certified verdict, submits the result manifest and submits it once more to record that acceptance is idempotent. |

`pnpm certify fixtures/component/hero --source-revision 1 --out /tmp/hero-cert`
reproduces the chain locally (no Job, no sidecar) and writes
`source-manifest.json`, the artifacts and `certification.json`.

**Mandatory checks.** `validator-dev-v1.json` names the checks a
certification must contain (`checks`: source contract, toolchain, protected
fixtures, npm package, declarations, browser module, CSS/resources, SSR
render, browser host). A run is `certified` only when every one of them
passed in that run (`complete: true`). `--no-ssr`/`--no-browser` make a
diagnostic run: its skipped checks are `not_run`, its verdict is
`infrastructure_failed`/`OBSERVER_FAILED`, `complete` is `false`, and
`certificationBinds` never accepts it for reuse; the Job refuses a
`host_checks` configuration that disables a mandatory check instead of
launching a run that could never certify. Removing a check from the profile
changes its digest, and with it every certification's binding.

## Profiles

`profiles/` holds the three trusted documents, each with a `profileDigest`
over its canonical content that the loader recomputes and refuses on
mismatch (`pnpm profiles:check`; `tsx src/profiles.ts --update` rewrites the
digests and the protected fixture digests after a reviewed edit):

- `build-support-dev-v1.json` — the contract's `buildSupportProfile`: Node
  24.19.0, pnpm 12.3.4, TypeScript 5.9.3, React 19.3.0, Puck
  (`@puckeditor/core`) 0.23.0, the allowed dependencies, the Host ABI id.
  The versions are what this package's lockfile installs; the loader
  compares them with the running toolchain and refuses a difference
  (`PROFILE_UNQUALIFIED`).
- `host-abi-dev-v1.json` — the Host ABI: ES module, the externals the host
  provides through its import map (`react`, `react/jsx-runtime`,
  `react-dom`, `react-dom/client`, `@puckeditor/core`), the entry export
  contract (default export is the Puck component config, `config` named),
  stylesheets loaded separately before the import. **DEVELOPMENT_ONLY**:
  its only evidence is this package's own host fixture. No Studio host, CSP
  or resource origin has been observed (ENV-08), and matching version
  strings are not host qualification.
- `validator-dev-v1.json` — the validator's toolchain pins (Rollup 4.63.3,
  `@rollup/plugin-typescript` 12.3.0, tslib 2.8.1, Playwright 1.62.1), the
  mandatory checks, the fixed failure-code → verdict mapping (`repairable`
  for source defects, `invalid` for escapes/tampering/bounds,
  `infrastructure_failed` for observer, profile, image and Pod failures,
  `canceled`), the digests of the protected fixtures (`ssr.mjs`, the
  browser `index.html`, `host.tsx` and `observer.js`) and the byte/time
  bounds.

`@measured/puck` is deprecated upstream in favour of `@puckeditor/core`
(the registry's deprecation notice, 2026-09-16); the profiles pin the
maintained package.

## Boundaries

- Trusted processes (`src/*.ts` except the workers) never import candidate
  modules. The build (`build-worker`), the SSR render and the browser host
  run as child processes with a bounded lifetime and their own `HOME`; on a
  developer host as the caller, in the Job image through util-linux's
  `setpriv` under the candidate identity (UID/GID 10001, groups cleared,
  bounding and inheritable capability sets emptied, `no_new_privs`) — see
  `src/isolation.ts`. This is the reviewed layout of DD-03 §5 expressed
  with a maintained tool, not a qualification of it: the fixed development
  Job runs reviewed content only and qualifies no candidate isolation.
- Stopping a step (P09 R2): the trusted process holds no CAP_KILL and
  cannot signal UID 10001, so after every step — at its bound and after a
  normal leader exit alike — the stop helper (`candidate-stop-worker`) runs
  under the same `setpriv` drop, kills the step's process group and then
  every remaining process of the step (group and session members,
  descendants of the trusted process, which is PID 1 of the Job container
  and therefore the parent of every orphan), round after round; the trusted
  process then confirms from its own read of `/proc` that nothing of the
  step remains before it reads what the step left. An unconfirmed stop is
  `OBSERVER_FAILED`: no later step runs and nothing is certified. On a
  developer host (caller identity) the trusted process signals the same set
  itself; `test/isolation.test.ts` exercises the Job's actual topology
  (PID 1 of a fresh PID namespace, UID 0 with SETUID/SETGID/SETPCAP only,
  steps as UID 10001) through `unshare` and `setpriv` when run as root.
- The candidate's lockfile is recorded by digest and checked for agreement
  with the declared dependencies; nothing is ever installed from it. The
  build resolves the externals' types from this package's locked install.
- Reports of the SSR and browser steps are read from files written under
  a fresh per-run directory; a step that exits 0 without a report, or with
  a report about other bytes, is `OBSERVER_FAILED`, never a pass. The
  browser step's report is the worker's observation through Playwright,
  never the page's: the main world is the candidate's to rewrite, and what
  it writes on `window` is carried as data only.
- The browser page reaches nothing: the worker answers every request of
  the synthetic host origin from the protected fixtures, the host bundles
  and the staged package through Playwright's interception (the container
  admits no AF_INET socket), every other origin is aborted at the request
  level and service workers are blocked. The image bakes in Playwright's
  Chromium headless shell
  (`PLAYWRIGHT_BROWSERS_PATH=/anvilkit/ms-playwright`) and the prebuilt
  host bundles (`fixtures/host/browser/dist`, built by
  `node dist/host-bundles.js` at image build time from the locked install,
  since the container's filesystem is read-only), so the Job runs the
  mandatory browser check itself.

## Verification

`pnpm install --frozen-lockfile` (no lifecycle script runs), then
`pnpm run check-types`, `pnpm run lint`, `pnpm run profiles:check`,
`pnpm run build`, `pnpm test` (Vitest; the build, SSR and Chromium steps
run real processes, 1–3 minutes). The tests cover the fixed source's
contract and digest behaviour, the refusals (links, case aliases, special
files, missing and undeclared files, unsupported dependencies, lockfile
disagreement, invalid package names and inexact versions, candidate
configuration, lifecycle scripts, bounds), the build's outputs and
reproducibility, refused imports (bare, stylesheet, absolute, escaping) and
type errors, the certification of the fixed component with its negatives
(wrong exports, missing CSS and resources, stylesheet references the
parser refuses, a module bundling its own React, an incompatible Host ABI,
altered protected fixtures, a forged exit 0, a candidate that renders
nothing and fabricates a success report, a candidate whose rendering
ignores the host's props, a diagnostic run that skipped a mandatory check,
the verdict mapping), the reuse rule (any changed binding or an incomplete
run invalidates an earlier certification), and the stop of a step's
processes (caller identity always; the Job's PID 1/no-CAP_KILL topology
through `unshare`/`setpriv` as root).
