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
| Complete source (P10a) | `src/source.ts` | The inventory is walked and hashed by trusted code (sorted normalized paths, actual bytes); the candidate's `component.json` declaration (entry, styles, resources, usage, editable fields) is checked against it; symbolic links, special and hard-linked files, case aliases, escapes, build configuration, lifecycle scripts, `node_modules` and dependencies outside the profile are refused; package and dependency names must be valid for a new registry package (`validate-npm-package-name`, no legacy names or special characters) and versions exact (`node-semver` strict parse whose canonical form is the input: no `v`, whitespace, build metadata, leading zeros or ranges; nothing is coerced or cleaned); the result satisfies `contracts/components` `sourceManifest`. With an allocated identity (the launch envelope's `component`, or the CLI's identity options) a `component.json` `componentId`/`puckType` or `package.json` `name` that differs from it is refused with `IDENTITY_MISMATCH` (verdict `invalid`): the candidate's own declaration never chooses what is certified (SEC-12). |
| Protected build (P10b) | `src/build.ts`, `src/build-worker.ts`, `src/tarball.ts` | Rollup with the TypeScript plugin, configured only from the profiles and this code (a trusted `tsconfig` in the work directory): one ES chunk importing only the Host ABI's externals, declarations under `dist/types`, stylesheets and resources copied byte for byte, the published `package.json` generated here (exact peer dependencies, no scripts, `anvilkit` metadata binding source and profile digests), and a reproducible gzipped tarball in npm layout (`package/`, fixed mtime, no owner) whose inventory is read back from its own bytes. At Rollup's resolve/load boundary only the inventoried `src/**` modules of the staged copy are loadable, each verified against its inventoried digest: absolute ids, relative ids that escape `src/`, virtual ids and any other byte on disk are refused, so the same source bytes and profiles build the same module whatever else changed; the externals' type declarations reach the compiler from this package's locked install only. |
| Independent Validator (P10c) | `src/validate.ts`, `fixtures/host/` | From the source read, the build's files and the exact profiles: the source contract and the toolchain re-established, the tarball's inventory, the module's imports and exports parsed from its bytes (`es-module-lexer`), inlined-runtime markers, declarations, CSS/resources with every reference parsed by `css-tree` (`url()`, `src()`, string URLs in `image-set()`, and `url()`/references inside custom properties and `var()` fallbacks, and string- and url-form `@import`; identifiers decoded, relative, inside the package, shipped and declared; parse errors refused — the browser never re-scans CSS text, it reuses this parsed list), the protected fixtures before and after use, then the SSR render (`fixtures/host/ssr.mjs`, two steps with nothing on disk between them: the render child — the only code that imports the candidate, as the candidate identity — reads its inputs on stdin before the import, renders the component through its own `render` and through Puck's `Render` with react-dom/server, and writes one frame (the two HTML strings and the meta) to fd 3, the orchestrator's pipe; once every process of the candidate identity is stopped and confirmed gone, the protected harness — under its own identity, never importing the candidate — gets the expectations and that frame as bytes on stdin, re-digests the module from disk and is the sole author of the verdict: each render present, non-empty and carrying the declared texts, the Puck render carrying a value the observer chose for one text field in this run, the output digests; its report goes to fd 3 as well. No report is ever read from a file a step could write, so a render that throws is never certified, whatever passing report, HTML, FIFO or link the candidate left in a file, and a frame it forges on its own descriptor cannot carry the value only a render of this run's props shows) and the browser host (`fixtures/host/browser/`: a page whose import map serves one React, one ReactDOM and one Puck; Playwright's Chromium headless shell — with Chromium's own sandbox wherever the runtime gives the step identity one — the session on stdin and the worker's report on fd 3, every request answered by the worker through Playwright's interception on a synthetic origin — no socket, since the P09 candidate seccomp profile admits AF_UNIX only). In the browser everything decisive is observed from outside the page's main world, which the candidate shares with the host script: the DOM and the CSSOM read in an isolated world by the protected `observer.js` (rendered elements and texts, each declared stylesheet compared with a fresh parse of the shipped bytes, its matching rules confirmed to take effect in the browser's computed style — not merely to load and match a selector — and its resources decoded), Playwright's request log (only the host bundles and the module load as scripts; every request is one the package accounts for), real input for the interaction, and a re-render through a handle to the host's frozen control object captured before the candidate module is imported, with a value only the worker knows, and a real click that must advance the fixed Hero's defined click-count (`data-clicks`) — a candidate that renders nothing and fabricates a success report on `window`, or whose click makes no state transition, fails. Exit codes and page reports are data; the verdict comes from what was observed. |
| Job entrypoint (P10d, P0.8) | `src/job.ts` | Reads the launch envelope, waits for the execution scope from the access sidecar's trusted socket, refuses a configuration that disables a mandatory check, resolves the launch's own Job profile from the contracts' `jobs/profiles.json` by `profileId` and applies the bound-source rule: a `source` input is accepted only under a profile with `bindsSource` (`validator-source-v1`, `validator-source-dev-v1`), which in turn requires exactly one `source` input with a handle and the allocated `component` identity — no fallback to the fixed Hero; a profile without it (`validator-fixture-v1`) runs the fixed Hero only. A launch the profile does not admit is refused before any source is loaded: a result without outputs, `infrastructure_failed`/`PROFILE_UNQUALIFIED`. The bound archive is loaded through the sidecar, verified against the envelope's digest and unpacked under the source rules; the chain certifies it at the envelope's `component.sourceRevision` and identity (the configured `source_revision` is the fixed Hero's own, used only when the launch names no identity). It uploads npm/browser/css/evidence through the sidecar's transfer route only under a complete certified verdict, submits the result manifest and submits it once more to record that acceptance is idempotent. |

`pnpm certify fixtures/component/hero --source-revision 1 --out /tmp/hero-cert`
reproduces the chain locally (no Job, no sidecar) and writes
`source-manifest.json`, the artifacts and `certification.json`.
`--source-revision` is required (the revision the certification binds, the
caller's); `--component-id`, `--puck-type` and `--package-name` (all three or
none) bind the allocated identity as the Job does (`IDENTITY_MISMATCH`, exit
1, otherwise); `--step-identity setpriv` runs the steps under the Job's UIDs
(root caller).

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
  for source defects, `invalid` for escapes/tampering/bounds and an
  identity that is not the allocated one (`IDENTITY_MISMATCH`),
  `infrastructure_failed` for observer, profile, image and Pod failures,
  `canceled`), the digests of the protected fixtures (`ssr.mjs`, the
  browser `index.html`, `host.tsx` and `observer.js`) and the byte/time
  bounds.

`@measured/puck` is deprecated upstream in favour of `@puckeditor/core`
(the registry's deprecation notice, 2026-09-16); the profiles pin the
maintained package.

## Boundaries

- Trusted processes (`src/*.ts` except the workers) never import candidate
  modules. The build (`build-worker`), the SSR render child, the SSR
  harness and the browser host run as child processes with a bounded
  lifetime, their inputs on stdin and their own `HOME`; on a developer host
  as the caller, in the Job image through util-linux's `setpriv` (groups
  cleared, bounding and inheritable capability sets emptied,
  `no_new_privs`): the build, the render child and the browser host as the
  candidate identity (UID/GID 10001), the harness that judges the render as
  the harness identity (UID/GID 10003; numeric, no passwd entry), so code
  that executes candidate source never shares a UID with the code that
  judges it — see `src/isolation.ts`. This is the reviewed layout of DD-03
  §5 expressed with a maintained tool, not a qualification of it (G-04).
- Reports travel over a pipe the trusted process owns: every step writes
  its report (the build result, the render frame, the harness's verdict,
  the browser observation) to its inherited fd 3, and the trusted process
  uses it only after the step's stop is confirmed and the pipe closed. No
  report is read from a file, so a passing report, HTML, FIFO or symbolic
  link a step leaves in a file it can write is never evidence. The step's
  `HOME`/`TMPDIR` is a scratch directory nothing is read from. The only
  step outputs read from disk are the build's artifacts (`index.js`, the
  declarations), and only as regular files: the tree is listed without
  following links and every file is read through `readStepOutput`
  (`lstat` and `fstat` of one inode, `O_NOFOLLOW`, `O_NONBLOCK`, bounded),
  so a FIFO, device or link is refused without blocking. A step that exits
  0 without a report, or with a report about other bytes, is
  `OBSERVER_FAILED`, never a pass.
- Stopping a step (P09 R2, VAL-05): the trusted process holds no CAP_KILL
  and cannot signal a step UID, so after every step — at its bound and
  after a normal leader exit alike — it runs the shell's kill builtin on pid
  -1 (`/bin/sh -c 'kill -s KILL -- -1'`) under each step UID that still
  has a live process, through the same `setpriv` drop: the kernel signals
  every process of that UID in the PID namespace (the helper itself
  excepted), whatever its parent, group or session. Round after round, the
  trusted process confirms from its own scan of `/proc` that no live
  process whose real, effective or saved UID is a step UID remains, before
  it reads anything the step left. The confirmation does not assume the
  trusted process is PID 1 or a subreaper: a detached process (double fork
  and `setsid`) reparented anywhere is found by its UID. It relies on the
  step UIDs belonging to the validator's steps alone in its PID namespace
  (the validator container; the codegen team container, which runs the
  validator only after its coder is confirmed stopped). An unconfirmed stop
  is `OBSERVER_FAILED`: no later step runs and nothing is certified. On a
  developer host (caller identity) the trusted process signals the step's
  group, session and descendants itself; that mode confirms no detached
  process. `test/isolation.test.ts` exercises a detached `setsid` process
  under fresh, unused UIDs from the ordinary (non-PID-1) test process and
  the Job's topology (PID 1 of a fresh PID namespace, UID 0 with
  SETUID/SETGID/SETPCAP only); `test/boundary.test.ts` runs the chain under
  UIDs 10001/10003 in a PID namespace where the trusted process is not
  PID 1 (root only).
- The candidate's lockfile is recorded by digest and checked for agreement
  with the declared dependencies; nothing is ever installed from it. The
  build resolves the externals' types from this package's locked install.
- The browser step's report is the worker's observation through
  Playwright, never the page's: the main world is the candidate's to
  rewrite, and what it writes on `window` is carried as data only. The
  candidate module runs in Chromium's renderer, which shares the worker's
  UID; Chromium's own sandbox is what keeps a compromised renderer away from
  the worker and its report pipe. The worker launches with it wherever the
  runtime gives the step identity one (a non-root identity with user
  namespaces; the setuid sandbox is impossible under `no_new_privs`). Under
  the DEVELOPMENT_ONLY validator profile (`chromiumSandbox: "preferred"`) a
  runtime without one runs without it and the report records why — as root
  (the caller identity on a developer host, where Chromium refuses its
  sandbox) and under the development foundation's containerd default
  seccomp profile, which refuses the user namespace; a QUALIFIED profile
  makes it `"required"` and its absence an infrastructure failure. Whether
  the boundary holds on the target runtime is G-04.
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
- The image is Debian 13 with the fixed perl-base pinned and no package
  manager of the Node base (npm, npx, corepack, yarn; pnpm is not
  installed). The headless shell links `libgbm.so.1` only for its own
  buffers and renders through its bundled SwiftShader, so the image carries
  Debian's `libgbm1` repacked without its DRI backend and that backend's
  `mesa-libgallium` dependency (version suffixed `+anvilkit1`, the Mesa
  binary otherwise unchanged) and none of Xvfb, the GL stack, Mesa's
  gallium drivers, LLVM or libxml2 (P0.8 AC7: CVE-2026-6653 has no fixed
  libxml2 in Debian 13); dpkg stays consistent for images built on it.

## Verification

`pnpm install --frozen-lockfile` (no lifecycle script runs), then
`pnpm run check-types`, `pnpm run lint`, `pnpm run profiles:check`,
`pnpm run build`, `pnpm test` (Vitest; the build, SSR and Chromium steps
run real processes, 3–6 minutes). The tests cover the fixed source's
contract and digest behaviour, the refusals (links, case aliases, special
files, missing and undeclared files, unsupported dependencies, lockfile
disagreement, invalid package names and inexact versions, candidate
configuration, lifecycle scripts, bounds, an identity other than the
allocated one), the build's outputs and reproducibility, refused imports
(bare, stylesheet, absolute, escaping) and type errors, the certification
of the fixed component with its negatives (wrong exports, missing CSS and
resources, stylesheet references the parser refuses, a module bundling its
own React, an incompatible Host ABI, altered protected fixtures, a forged
exit 0 of the render child and of the harness, the VAL-01 reproduction —
a throwing render that writes passing reports wherever it can, forges a
render frame on its own descriptor, or plants FIFOs and links at the report
paths — a candidate that renders nothing and fabricates a success report,
a candidate whose rendering ignores the host's props, a diagnostic run
that skipped a mandatory check, the verdict mapping, the identity and
source-revision binding), the reuse rule, the reads of step output files
(FIFO, links, device, directory, size), the stop of a step's processes, the
Job against a fake access sidecar (the bound-source rule's refusals, an
identity mismatch, a bound source certified at the launch's revision) and
the CLI's required revision and identity options. The root-only tests (real
step UIDs, PID and mount namespaces: `test/isolation.test.ts`,
`test/boundary.test.ts`, the Job tests) are skipped without root and fail
instead under `ANVILKIT_REQUIRE_ROOT_TESTS=1`. `sh tools/image-smoke.sh
<image>` checks a built image without network: the package state above,
every library the headless shell links resolvable, and a complete
certification of the fixed component inside the image under the Job's
capability set (SETUID, SETGID, SETPCAP) and the setpriv step identities,
the browser check in the image's own Chromium. `.github/workflows/ci.yml`
runs the whole chain, with Playwright's Chromium headless shell and the
tests as root, then builds the image and runs the smoke check on it.
