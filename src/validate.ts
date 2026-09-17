// The independent Validator (DD-04 §3): from the immutable source read, the
// build's files and the exact profiles it re-establishes every fact it
// certifies — the tarball's own inventory and bytes, the module's imports
// and exports parsed from its bytes, the stylesheets and resources retained
// byte for byte, the declarations, the protected fixtures before and after
// use, and the renders of the SSR and browser fixtures in child processes.
// Exit codes and self-reports of those steps are data; a verdict comes only
// from what the observer verified. The certification binds the digests of
// source, profiles, npm, browser, CSS and Host ABI; any change of one of
// them makes an earlier certification unusable.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as csstree from "css-tree";
import { init as initLexer, parse as parseModule } from "es-module-lexer";
import type { ArtifactFile, BuildOutput } from "./build.js";
import { componentsSchemaId, validateAgainst } from "./contracts.js";
import { canonicalDigest, type Digest, sequence, sha256 } from "./digest.js";
import type { BrowserSession, BrowserWorkerResult } from "./host-browser-worker.js";
import { ensureHostBundles, type HostBundles } from "./host-bundles.js";
import { runStep, type StepIdentity, type StepOutcome, type StepStop, workerArgv } from "./isolation.js";
import { type Profiles, packageRoot, protectedFixtureDigests, type Verdict, verifyToolchain } from "./profiles.js";
import { manifestDigest, type SourceRead } from "./source.js";
import { readTarball } from "./tarball.js";

export type FailureCode =
	| "CANDIDATE_BUILD_FAILED"
	| "CANDIDATE_TEST_FAILED"
	| "PROTECTED_FIXTURE_ALTERED"
	| "MISSING_CSS"
	| "INVALID_EXPORTS"
	| "DUPLICATE_RUNTIME"
	| "PATH_ESCAPE"
	| "PROFILE_UNQUALIFIED"
	| "IMAGE_PULL_FAILED"
	| "POD_EVICTED"
	| "DEADLINE_EXCEEDED"
	| "OBSERVER_FAILED"
	| "RESULT_DIGEST_MISMATCH"
	| "CANCELED";

export interface CheckResult {
	name: string;
	status: "pass" | "fail" | "not_run";
	failureCode?: FailureCode;
	detail?: string;
}

export interface StepEvidence {
	identity: StepIdentity["mode"];
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	durationMs: number;
	/** The stop of the step's processes as the trusted process confirmed it (P09 R2). */
	stop: StepStop;
	/** The last bytes of the step's stderr (bounded; private evidence, never a log or a termination message). */
	stderrTail?: string;
}

export interface CertificationBindings {
	componentId: string;
	puckType: string;
	sourceRevision: string;
	sourceDigest: Digest;
	packageName: string;
	version: string;
	buildProfileId: string;
	buildProfileDigest: Digest;
	validatorProfileId: string;
	validatorProfileDigest: Digest;
	hostAbi: string;
	hostAbiDigest: Digest;
	npm: { digest: Digest; sizeBytes: string };
	browser: { digest: Digest; sizeBytes: string };
	css: ArtifactFile[];
	declarations: ArtifactFile[];
	resources: ArtifactFile[];
	protectedFixtures: Record<string, Digest>;
	hostBundles?: Record<string, Digest>;
	toolchain: Record<string, string>;
}

export interface Certification {
	schemaVersion: 1;
	verdict: Verdict;
	failureCode?: FailureCode;
	/**
	 * True only when every mandatory check of the validator profile passed
	 * in this run. A run that skipped one (a diagnostic run) is never
	 * certified and is never reused as a certification.
	 */
	complete: boolean;
	/** The mandatory checks, as the validator profile names them. */
	mandatoryChecks: string[];
	checks: CheckResult[];
	bindings: CertificationBindings;
	npmEntries: Array<{ path: string; digest: Digest; sizeBytes: string }>;
	browser: { imports: string[]; exports: string[] };
	host: { status: "DEVELOPMENT_ONLY" | "QUALIFIED"; ssr?: unknown; browser?: unknown };
	steps: { build: StepEvidence; ssr?: StepEvidence; browser?: StepEvidence };
	startedAt: string;
	completedAt: string;
	evidenceDigest: Digest;
}

export interface CertifyInput {
	source: SourceRead;
	build: BuildOutput;
	profiles: Profiles;
	toolchain: Record<string, string>;
	identity: StepIdentity;
	hostChecks: { ssr: boolean; browser: boolean };
	/** Root of the protected fixtures (fixtures/host); the package root by default. */
	fixturesRoot?: string;
	/** Test seam: replaces the argv of a step (never used by the Job). */
	stepArgv?: { ssr?: string[]; browser?: string[] };
	now?: () => Date;
}

/** Verdict of a failure code under the validator profile's fixed mapping. */
export function verdictFor(profiles: Profiles, code: FailureCode): Verdict {
	for (const [verdict, codes] of Object.entries(profiles.validator.verdicts)) {
		if (codes.includes(code)) return verdict as Verdict;
	}
	return "infrastructure_failed";
}

/** Markers of a bundled runtime: what a module carries only when it inlined React, ReactDOM or Puck. */
const runtimeMarkers: Array<{ runtime: string; markers: string[] }> = [
	{
		runtime: "react",
		markers: ['Symbol.for("react.', "Symbol.for('react.", "__CLIENT_INTERNALS_DO_NOT_USE", "ReactSharedInternals"],
	},
	{
		runtime: "react-dom",
		markers: ["__DOM_INTERNALS_DO_NOT_USE", "react-dom.production", "reactDOMClientPackageVersion"],
	},
	{ runtime: "@puckeditor/core", markers: ["data-puck-", "must be used inside <Puck>"] },
];

class CheckFailure extends Error {
	constructor(
		readonly code: FailureCode,
		message: string,
	) {
		super(message);
	}
}

function stepEvidence(s: StepOutcome, identity: StepIdentity): StepEvidence {
	const out: StepEvidence = {
		identity: identity.mode,
		code: s.code,
		signal: s.signal,
		timedOut: s.timedOut,
		durationMs: s.durationMs,
		stop: s.stop,
	};
	if (s.stderr) out.stderrTail = s.stderr.slice(-2000);
	return out;
}

/** Reads an entry's bytes from the staged package directory (the same bytes the tarball holds, verified by digest). */
function packageBytes(build: BuildOutput, rel: string, expected: Digest): Buffer {
	const bytes = readFileSync(path.join(build.packageDir, rel));
	if (sha256(bytes) !== expected)
		throw new CheckFailure("OBSERVER_FAILED", `${rel}: the staged file is not the tarball's entry`);
	return bytes;
}

/** What a shipped stylesheet references, established from its bytes by a CSS parser (css-tree). */
export interface StylesheetReferences {
	/** Package-relative paths (dist/…) of every url()/src() resource, sorted, unique. */
	resources: string[];
	/** Package-relative paths (dist/…) of every @import target, sorted, unique. */
	imports: string[];
	/** Style rules in source order (their selectors, as written), for the browser's CSSOM comparison. */
	selectors: string[];
}

/**
 * Parses a stylesheet the package ships and resolves every reference under
 * the existing rules: relative paths only (no data:, http(s):, protocol-relative
 * or absolute references), percent-decoded, no escape above the package's
 * dist/ root, and every target present in the tarball. A stylesheet that
 * does not parse cleanly, or whose reference cannot be reviewed, is refused:
 * the browser is never the first to decide what a stylesheet loads.
 */
export function stylesheetReferences(
	rel: string,
	text: string,
	shipped: (packagePath: string) => boolean,
	fail: (message: string) => never,
): StylesheetReferences {
	const errors: string[] = [];
	const ast = csstree.parse(text, {
		positions: true,
		// Parse custom-property values too (the default leaves `--x: …` and a
		// var() fallback as Raw), so url() references inside custom properties
		// and var() fallbacks are walked and reviewed like any other.
		parseCustomProperty: true,
		onParseError: (err) => errors.push(`${err.message} (line ${err.line ?? "?"})`),
	});
	if (errors.length) fail(`${rel} does not parse as CSS: ${errors[0]}`);
	const resolve = (ref: string, what: string): string => {
		if (ref.includes("\0") || /^\s*$/.test(ref)) fail(`${rel}: ${what} reference is empty or unreviewable`);
		if (/^(data:|blob:|javascript:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref))
			fail(`${rel} references ${ref}; only shipped relative resources are allowed`);
		if (ref.startsWith("/") || ref.startsWith("\\")) fail(`${rel} references the absolute path ${ref}`);
		const stripped = ref.split("#")[0]?.split("?")[0] ?? "";
		let decoded: string;
		try {
			decoded = decodeURIComponent(stripped);
		} catch {
			return fail(`${rel} references ${ref}, which does not percent-decode`);
		}
		if (!decoded || decoded.includes("\0") || decoded.includes("\\"))
			fail(`${rel} references ${ref}, which cannot be reviewed`);
		const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), decoded));
		if (target.startsWith("../") || target === ".." || path.posix.isAbsolute(target))
			fail(`${rel} references ${ref}, which escapes the package`);
		if (!shipped(`dist/${target}`)) fail(`${rel} references ${ref}, which the package does not ship`);
		return `dist/${target}`;
	};
	const resources = new Set<string>();
	const imports = new Set<string>();
	const selectors: string[] = [];
	csstree.walk(ast, {
		enter(node: csstree.CssNode) {
			switch (node.type) {
				case "Atrule": {
					const name = node.name.toLowerCase();
					if (name === "import") {
						const first = node.prelude?.type === "AtrulePrelude" ? node.prelude.children.first : null;
						if (!first || (first.type !== "String" && first.type !== "Url"))
							return fail(`${rel}: @import without a reviewable target`);
						const target = resolve(first.value, "@import");
						if (!target.endsWith(".css")) fail(`${rel} imports ${first.value}, which is not a shipped stylesheet`);
						imports.add(target);
						return csstree.walk.skip;
					}
					return;
				}
				case "Url":
					resources.add(resolve(node.value, "url()"));
					return;
				case "Function": {
					const fname = node.name.toLowerCase();
					if (fname === "src") {
						const first = node.children.first;
						if (first?.type !== "String") return fail(`${rel}: src() without a reviewable target`);
						resources.add(resolve(first.value, "src()"));
					} else if (fname === "image-set" || fname === "-webkit-image-set") {
						// Bare string entries of image-set() are resource references too;
						// its url() entries are caught by the Url case below.
						node.children.forEach((child) => {
							if (child.type === "String") resources.add(resolve(child.value, "image-set()"));
						});
					}
					return;
				}
				case "Rule":
					selectors.push(node.prelude.type === "Raw" ? node.prelude.value : csstree.generate(node.prelude));
					return;
				default:
					return;
			}
		},
	});
	return { resources: [...resources].sort(), imports: [...imports].sort(), selectors };
}

export async function certify(input: CertifyInput): Promise<Certification> {
	const { source, build, profiles } = input;
	const limits = profiles.validator.limits;
	const now = input.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const fixturesRoot = input.fixturesRoot ?? packageRoot;
	const checks: CheckResult[] = [];
	const steps: Certification["steps"] = { build: stepEvidence(build.step, { mode: build.step.identity }) };
	const host: Certification["host"] = { status: profiles.host.status };
	let failure: CheckFailure | undefined;
	const run = async (name: string, fn: () => Promise<void> | void): Promise<boolean> => {
		if (failure && (name === "ssr-render" || name === "browser-host")) {
			checks.push({ name, status: "not_run", detail: "an earlier check failed; candidate content is not executed" });
			return false;
		}
		try {
			await fn();
			checks.push({ name, status: "pass" });
			return true;
		} catch (err) {
			const f =
				err instanceof CheckFailure ? err : new CheckFailure("OBSERVER_FAILED", String((err as Error).message ?? err));
			checks.push({ name, status: "fail", failureCode: f.code, detail: f.message });
			failure ??= f;
			return false;
		}
	};

	// The source read and the toolchain are re-established here, so that
	// every mandatory check of the profile has a result of this run.
	await run("source-contract", () => {
		const shape = validateAgainst(`${componentsSchemaId}#/$defs/sourceManifest`, source.manifest);
		if (shape)
			throw new CheckFailure("CANDIDATE_BUILD_FAILED", `the source manifest does not satisfy the contract: ${shape}`);
		if (manifestDigest(source.files) !== source.manifest.manifestDigest)
			throw new CheckFailure("OBSERVER_FAILED", "the source bytes are not the manifest's");
		if (source.manifest.files.length !== source.files.size)
			throw new CheckFailure("OBSERVER_FAILED", "the source inventory and the manifest differ");
	});
	await run("toolchain", () => {
		let actual: Record<string, string>;
		try {
			actual = verifyToolchain(profiles);
		} catch (err) {
			throw new CheckFailure("PROFILE_UNQUALIFIED", (err as Error).message);
		}
		if (canonicalDigest(actual) !== canonicalDigest(input.toolchain))
			throw new CheckFailure("PROFILE_UNQUALIFIED", "the toolchain handed over is not the installed one");
	});

	// Protected fixtures before anything of them is used.
	const fixturesBefore = protectedFixtureDigests(profiles, fixturesRoot);
	const altered = Object.entries(profiles.validator.protectedFixtures).filter(([rel, d]) => fixturesBefore[rel] !== d);
	await run("protected-fixtures", () => {
		if (altered.length)
			throw new CheckFailure("PROTECTED_FIXTURE_ALTERED", `altered: ${altered.map(([r]) => r).join(", ")}`);
	});

	// The npm package, from the tarball's own bytes.
	const tarBytes = readFileSync(build.npm.file);
	const npmDigest = sha256(tarBytes);
	let entries: Awaited<ReturnType<typeof readTarball>> = [];
	let packageJson: Record<string, unknown> = {};
	const decl = source.declaration;
	await run("npm-package", async () => {
		if (tarBytes.byteLength > limits.maxNpmTarballBytes)
			throw new CheckFailure(
				"CANDIDATE_BUILD_FAILED",
				`tarball ${tarBytes.byteLength} bytes exceeds ${limits.maxNpmTarballBytes}`,
			);
		entries = await readTarball(build.npm.file, {
			maxEntries: 4096,
			maxUncompressedBytes: limits.maxNpmTarballBytes * 8,
		});
		const byPath = new Map(entries.map((e) => [e.path, e]));
		const pkgEntry = byPath.get("package.json");
		if (!pkgEntry) throw new CheckFailure("INVALID_EXPORTS", "the package has no package.json");
		packageJson = JSON.parse(packageBytes(build, "package.json", pkgEntry.digest).toString("utf8")) as Record<
			string,
			unknown
		>;
		if (packageJson.name !== source.packageName || packageJson.version !== source.packageVersion) {
			throw new CheckFailure(
				"INVALID_EXPORTS",
				`package ${packageJson.name}@${packageJson.version} is not ${source.packageName}@${source.packageVersion}`,
			);
		}
		if ("scripts" in packageJson || "dependencies" in packageJson)
			throw new CheckFailure("INVALID_EXPORTS", "the package carries scripts or dependencies");
		const exportsMap = packageJson.exports as Record<string, unknown> | undefined;
		const root = exportsMap?.["."] as { import?: string; types?: string } | undefined;
		if (root?.import !== "./dist/index.js" || root?.types !== "./dist/types/index.d.ts")
			throw new CheckFailure(
				"INVALID_EXPORTS",
				'exports["."] does not name ./dist/index.js and ./dist/types/index.d.ts',
			);
		for (const rel of ["dist/index.js", "dist/types/index.d.ts", decl.usage]) {
			if (!byPath.has(rel)) throw new CheckFailure("INVALID_EXPORTS", `the package lacks ${rel}`);
		}
		const peers = (packageJson.peerDependencies ?? {}) as Record<string, string>;
		const declared = source.manifest.dependencies;
		if (Object.keys(peers).sort().join("\n") !== Object.keys(declared).sort().join("\n"))
			throw new CheckFailure("INVALID_EXPORTS", "peer dependencies differ from the source's dependencies");
		for (const [name, version] of Object.entries(peers)) {
			if (declared[name] !== version)
				throw new CheckFailure(
					"INVALID_EXPORTS",
					`peer ${name}@${version} differs from the source's ${declared[name]}`,
				);
			const served = profiles.host.externals[name];
			if (served !== undefined && served !== version)
				throw new CheckFailure(
					"PROFILE_UNQUALIFIED",
					`the Host ABI serves ${name}@${served}, the package needs ${version}`,
				);
		}
		const meta = packageJson.anvilkit as Record<string, unknown> | undefined;
		if (
			meta?.sourceDigest !== source.manifest.manifestDigest ||
			meta?.buildProfileDigest !== profiles.build.profileDigest ||
			meta?.hostAbi !== profiles.host.hostAbi
		) {
			throw new CheckFailure("OBSERVER_FAILED", "the package metadata does not bind this source and these profiles");
		}
		const unexpected = entries.filter(
			(e) => !(e.path === "package.json" || e.path === decl.usage || e.path.startsWith("dist/")),
		);
		if (unexpected.length)
			throw new CheckFailure(
				"INVALID_EXPORTS",
				`unexpected package entries: ${unexpected.map((e) => e.path).join(", ")}`,
			);
		for (const e of entries)
			if (e.mode & 0o111) throw new CheckFailure("INVALID_EXPORTS", `${e.path}: executable entry`);
	});
	const byPath = new Map(entries.map((e) => [e.path, e]));

	// Declarations: present, non-empty, naming the entry exports.
	const declarations: ArtifactFile[] = [];
	await run("declarations", () => {
		const listed = ((packageJson.anvilkit as { declarations?: string[] } | undefined)?.declarations ?? [])
			.slice()
			.sort();
		const inTar = entries
			.filter((e) => e.path.startsWith("dist/types/") && e.path.endsWith(".d.ts"))
			.map((e) => e.path);
		if (listed.join("\n") !== inTar.join("\n"))
			throw new CheckFailure("INVALID_EXPORTS", "declaration files differ from the package's list");
		const entry = byPath.get("dist/types/index.d.ts");
		if (!entry) throw new CheckFailure("INVALID_EXPORTS", "dist/types/index.d.ts is missing");
		const text = packageBytes(build, "dist/types/index.d.ts", entry.digest).toString("utf8");
		if (!/export default /.test(text))
			throw new CheckFailure("INVALID_EXPORTS", "the entry declaration has no default export");
		for (const named of profiles.host.entryExports.named) {
			if (!new RegExp(`\\b${named}\\b`).test(text))
				throw new CheckFailure("INVALID_EXPORTS", `the entry declaration does not declare ${named}`);
		}
		for (const p of inTar)
			declarations.push({
				path: p,
				digest: (byPath.get(p) as { digest: Digest }).digest,
				sizeBytes: (byPath.get(p) as { sizeBytes: string }).sizeBytes,
			});
	});

	// The browser module from its bytes: imports only the Host ABI's
	// externals, no dynamic import, the entry export contract, no inlined
	// runtime, byte-identical to the tarball entry.
	let browserImports: string[] = [];
	let browserExports: string[] = [];
	let moduleBytes: Buffer = Buffer.alloc(0);
	await run("browser-module", async () => {
		const entry = byPath.get("dist/index.js");
		if (!entry) throw new CheckFailure("INVALID_EXPORTS", "dist/index.js is missing from the package");
		moduleBytes = packageBytes(build, "dist/index.js", entry.digest);
		if (moduleBytes.byteLength === 0) throw new CheckFailure("INVALID_EXPORTS", "the browser module is empty");
		if (moduleBytes.byteLength > limits.maxBrowserModuleBytes)
			throw new CheckFailure(
				"CANDIDATE_BUILD_FAILED",
				`browser module ${moduleBytes.byteLength} bytes exceeds ${limits.maxBrowserModuleBytes}`,
			);
		await initLexer();
		const text = moduleBytes.toString("utf8");
		let parsed: ReturnType<typeof parseModule>;
		try {
			parsed = parseModule(text, "index.js");
		} catch (err) {
			throw new CheckFailure("INVALID_EXPORTS", `the browser module does not parse as ESM: ${(err as Error).message}`);
		}
		const [imports, exportsList] = parsed;
		const specifiers = new Set<string>();
		for (const imp of imports) {
			if (imp.type !== "static")
				throw new CheckFailure(
					"INVALID_EXPORTS",
					`the browser module uses a ${imp.type} import; only static imports of the Host ABI's externals are accepted`,
				);
			if (imp.phase) throw new CheckFailure("INVALID_EXPORTS", `the browser module uses a ${imp.phase}-phase import`);
			specifiers.add(imp.specifier);
		}
		browserImports = [...specifiers].sort();
		for (const spec of browserImports) {
			if (!(spec in profiles.host.externals))
				throw new CheckFailure(
					"DUPLICATE_RUNTIME",
					`the module imports ${spec}, which the Host ABI ${profiles.host.hostAbi} does not provide`,
				);
		}
		browserExports = exportsList
			.map((e) => {
				if (e.type !== "direct" && e.type !== "reexport")
					throw new CheckFailure(
						"INVALID_EXPORTS",
						"the browser module re-exports a whole module; exports must be explicit",
					);
				return e.name;
			})
			.sort();
		if (!browserExports.includes("default"))
			throw new CheckFailure("INVALID_EXPORTS", "the browser module has no default export");
		for (const named of profiles.host.entryExports.named) {
			if (!browserExports.includes(named))
				throw new CheckFailure("INVALID_EXPORTS", `the browser module does not export ${named}`);
		}
		for (const { runtime, markers } of runtimeMarkers) {
			for (const m of markers) {
				if (text.includes(m))
					throw new CheckFailure(
						"DUPLICATE_RUNTIME",
						`the module carries ${runtime} runtime code (${JSON.stringify(m)}); the host provides ${runtime}`,
					);
			}
		}
		if (!browserImports.includes("react") && !browserImports.includes("react/jsx-runtime")) {
			throw new CheckFailure("DUPLICATE_RUNTIME", "the module renders without importing the host's React");
		}
	});

	// CSS and resources: every declared stylesheet shipped byte for byte,
	// non-empty, bounded, its url() references shipped too.
	const css: ArtifactFile[] = [];
	const resources: ArtifactFile[] = [];
	const stylesheets = new Map<string, StylesheetReferences>();
	await run("css-resources", () => {
		if (decl.styles.length === 0)
			throw new CheckFailure(
				"MISSING_CSS",
				"the source declares no stylesheet; a component ships its styles separately",
			);
		let total = 0;
		for (const rel of decl.styles) {
			const entry = byPath.get(`dist/${rel}`);
			const sourceDigest = source.manifest.files.find((f) => f.path === rel)?.digest;
			if (!entry) throw new CheckFailure("MISSING_CSS", `${rel} is not in the package`);
			if (entry.digest !== sourceDigest)
				throw new CheckFailure("MISSING_CSS", `${rel} differs from the source stylesheet`);
			const bytes = packageBytes(build, `dist/${rel}`, entry.digest);
			if (bytes.byteLength === 0) throw new CheckFailure("MISSING_CSS", `${rel} is empty`);
			total += bytes.byteLength;
			const refs = stylesheetReferences(
				rel,
				bytes.toString("utf8"),
				(p) => byPath.has(p),
				(message) => {
					throw new CheckFailure("MISSING_CSS", message);
				},
			);
			for (const imported of refs.imports) {
				if (!decl.styles.includes(imported.slice("dist/".length)))
					throw new CheckFailure("MISSING_CSS", `${rel} imports ${imported}, which is not a declared stylesheet`);
			}
			stylesheets.set(rel, refs);
			css.push({ path: rel, digest: entry.digest, sizeBytes: entry.sizeBytes });
		}
		if (total > limits.maxCssBytes)
			throw new CheckFailure(
				"CANDIDATE_BUILD_FAILED",
				`stylesheets total ${total} bytes exceeds ${limits.maxCssBytes}`,
			);
		for (const rel of decl.resources) {
			const entry = byPath.get(`dist/${rel}`);
			const sourceDigest = source.manifest.files.find((f) => f.path === rel)?.digest;
			if (!entry || entry.digest !== sourceDigest)
				throw new CheckFailure("MISSING_CSS", `resource ${rel} is not shipped as in the source`);
			resources.push({ path: rel, digest: entry.digest, sizeBytes: entry.sizeBytes });
		}
	});

	// Host fixtures: candidate content executes only here, in child
	// processes under the step identity, and only when the static checks
	// passed.
	const fieldNames = decl.editableFields.map((f) => f.name);
	const defaultProps: Record<string, unknown> = {};
	for (const f of decl.editableFields) if (f.default !== undefined) defaultProps[f.name] = f.default;
	const expectedTexts = decl.editableFields
		.filter(
			(f) => (f.type === "text" || f.type === "textarea") && typeof f.default === "string" && f.default.length > 0,
		)
		.map((f) => f.default as string);
	// A fresh directory per certification: a report of an earlier run is
	// never read as this run's evidence.
	const evidenceDir = path.join(build.workDir, `observer-${randomBytes(6).toString("hex")}`);
	if (existsSync(evidenceDir)) throw new CheckFailure("OBSERVER_FAILED", "evidence directory already exists");
	mkdirSync(evidenceDir, { recursive: false, mode: 0o755 });
	// Each step writes its report and scratch into its own world-writable
	// directory of the root-owned evidence tree (the observer holds no
	// CAP_CHOWN in the Job); the observer reads the report as data.
	const stepDir = (name: string): string => {
		const dir = path.join(evidenceDir, name);
		mkdirSync(dir);
		chmodSync(dir, 0o1777);
		return dir;
	};
	const moduleDigest = sha256(moduleBytes);

	if (input.hostChecks.ssr) {
		await run("ssr-render", async () => {
			const dir = stepDir("ssr");
			const expectations = path.join(evidenceDir, "ssr-expectations.json");
			const resultPath = path.join(dir, "ssr-result.json");
			if (existsSync(resultPath)) throw new CheckFailure("OBSERVER_FAILED", "a report exists before the SSR step ran");
			writeFileSync(
				expectations,
				JSON.stringify({
					modulePath: build.browser.file,
					moduleDigest,
					puckType: decl.puckType,
					fieldNames,
					defaultProps,
					expectedTexts,
				}),
				{ mode: 0o444 },
			);
			const argv = input.stepArgv?.ssr ?? [process.execPath, path.join(fixturesRoot, "fixtures", "host", "ssr.mjs")];
			const step = await runStep([...argv, expectations, resultPath], {
				cwd: packageRoot,
				env: { HOME: dir, TMPDIR: dir },
				timeoutMs: limits.hostCheckTimeoutMs,
				identity: input.identity,
			});
			steps.ssr = stepEvidence(step, input.identity);
			if (!step.stop.confirmed) throw new CheckFailure("OBSERVER_FAILED", `the SSR step's ${step.stop.error}`);
			if (step.timedOut) throw new CheckFailure("DEADLINE_EXCEEDED", "the SSR step exceeded its bound");
			if (!existsSync(resultPath))
				throw new CheckFailure(
					"OBSERVER_FAILED",
					`the SSR step left no report (exit ${step.code}); an exit code certifies nothing`,
				);
			const report = JSON.parse(readFileSync(resultPath, "utf8")) as {
				ok?: boolean;
				moduleDigest?: string;
				exports?: string[];
				fields?: string[];
				errors?: string[];
				directHtmlDigest?: string;
				puckHtmlDigest?: string;
				reactVersion?: string;
			};
			host.ssr = report;
			// The module digest is the harness's own read of the built module from
			// disk, not anything the candidate reported; a mismatch means the step
			// observed other bytes than the observer handed over.
			if (report.moduleDigest !== moduleDigest)
				throw new CheckFailure("OBSERVER_FAILED", "the SSR report is not about the module the observer handed over");
			// Whether the render completed is decided before the exports are read:
			// a candidate that exits without rendering, or forges a report the
			// trusted harness rejects, leaves no completed render — a candidate
			// failure, not an exports mismatch.
			if (report.ok !== true)
				throw new CheckFailure("CANDIDATE_TEST_FAILED", (report.errors ?? []).join("; ") || "SSR render failed");
			if ((report.exports ?? []).join("\n") !== browserExports.join("\n"))
				throw new CheckFailure(
					"INVALID_EXPORTS",
					"the exports seen at runtime differ from the module's static exports",
				);
			if (report.reactVersion !== profiles.host.externals.react)
				throw new CheckFailure(
					"PROFILE_UNQUALIFIED",
					`SSR ran React ${report.reactVersion}, the Host ABI freezes ${profiles.host.externals.react}`,
				);
			if (!report.directHtmlDigest || !report.puckHtmlDigest)
				throw new CheckFailure("OBSERVER_FAILED", "the SSR report carries no rendered output");
		});
	} else {
		checks.push({ name: "ssr-render", status: "not_run", detail: "not enabled for this run" });
	}

	let bundles: HostBundles | undefined;
	if (input.hostChecks.browser) {
		await run("browser-host", async () => {
			bundles = await ensureHostBundles(profiles, input.toolchain);
			const cssText: Record<string, string> = {};
			// The resources each stylesheet references, already parsed statically
			// with css-tree above (url(), src(), image-set() and @import in custom
			// properties and var() fallbacks alike): the browser only confirms
			// each loads, it does not re-extract them, so the isolated-world
			// observer needs no CSS scanning of its own.
			const cssResources: Record<string, string[]> = {};
			for (const rel of decl.styles) {
				const entry = byPath.get(`dist/${rel}`) as { digest: Digest };
				const href = `/candidate/dist/${rel}`;
				cssText[href] = packageBytes(build, `dist/${rel}`, entry.digest).toString("utf8");
				cssResources[href] = (stylesheets.get(rel)?.resources ?? []).map((p) => `/candidate/${p}`);
			}
			// The field the worker re-renders with a value of its own: the first
			// declared text field (a component without one has nothing to show).
			const nonceField =
				decl.editableFields.find((f) => (f.type === "text" || f.type === "textarea") && typeof f.default === "string")
					?.name ?? null;
			const session: BrowserSession = {
				htmlPath: path.join(fixturesRoot, "fixtures", "host", "browser", "index.html"),
				observerPath: path.join(fixturesRoot, "fixtures", "host", "browser", "observer.js"),
				hostDir: bundles.dir,
				candidateDir: build.packageDir,
				moduleUrl: "/candidate/dist/index.js",
				cssUrls: decl.styles.map((s) => `/candidate/dist/${s}`),
				cssText,
				cssResources,
				puckType: decl.puckType,
				fieldNames,
				defaultProps,
				expectedTexts,
				nonceField,
				interaction: profiles.validator.interaction ?? null,
				timeoutMs: Math.max(5_000, limits.hostCheckTimeoutMs - 10_000),
			};
			const dir = stepDir("browser");
			const sessionPath = path.join(evidenceDir, "browser-session.json");
			const resultPath = path.join(dir, "browser-result.json");
			if (existsSync(resultPath))
				throw new CheckFailure("OBSERVER_FAILED", "a report exists before the browser step ran");
			writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o444 });
			const argv = input.stepArgv?.browser ?? workerArgv("host-browser-worker");
			const step = await runStep([...argv, sessionPath, resultPath], {
				cwd: packageRoot,
				// The browsers are the trusted install's (the image bakes them in
				// and names the directory); the step's HOME is its evidence directory.
				env: {
					HOME: dir,
					TMPDIR: dir,
					PLAYWRIGHT_BROWSERS_PATH:
						process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), ".cache", "ms-playwright"),
				},
				timeoutMs: limits.hostCheckTimeoutMs,
				identity: input.identity,
			});
			steps.browser = stepEvidence(step, input.identity);
			if (!step.stop.confirmed) throw new CheckFailure("OBSERVER_FAILED", `the browser step's ${step.stop.error}`);
			if (step.timedOut) throw new CheckFailure("DEADLINE_EXCEEDED", "the browser step exceeded its bound");
			if (!existsSync(resultPath))
				throw new CheckFailure(
					"OBSERVER_FAILED",
					`the browser step left no report (exit ${step.code}); an exit code certifies nothing`,
				);
			const report = JSON.parse(readFileSync(resultPath, "utf8")) as BrowserWorkerResult;
			host.browser = report;
			// What decides below is the worker's observation through Playwright
			// (isolated world, its request log, real input, the captured control)
			// and the server's log; report.page is the main world's own account
			// and is carried as data only.
			if (report.kind === "infrastructure")
				throw new CheckFailure("OBSERVER_FAILED", report.error ?? "browser step failed");
			if (report.kind === "timeout")
				throw new CheckFailure("CANDIDATE_TEST_FAILED", report.error ?? "the host page did not finish");
			if (report.kind === "candidate" || !report.observed)
				throw new CheckFailure("CANDIDATE_TEST_FAILED", report.error ?? "the host page could not be observed");
			const observed = report.observed;
			// The module served was the exact artifact: the server log shows it and the stylesheets requested.
			const served = new Set(report.requests.filter((r) => r.status === 200).map((r) => r.path));
			if (!served.has(session.moduleUrl))
				throw new CheckFailure("CANDIDATE_TEST_FAILED", "the page did not load the browser module");
			for (const cssUrl of session.cssUrls)
				if (!served.has(cssUrl)) throw new CheckFailure("MISSING_CSS", `the page did not load ${cssUrl}`);
			// Every request the page made is one the host page, the host bundles
			// or the shipped package account for; the only script besides the
			// host's bundles is the module itself (one React, one Puck).
			const allowed = new Set<string>(["/", "/session.json", session.moduleUrl, ...session.cssUrls]);
			for (const refs of stylesheets.values()) {
				for (const p of [...refs.resources, ...refs.imports]) allowed.add(`/candidate/${p}`);
			}
			for (const r of report.pageRequests) {
				const p = new URL(r.url).pathname;
				if (p.startsWith("/host/")) {
					if (!/^\/host\/[A-Za-z0-9._-]+\.js$/.test(p))
						throw new CheckFailure("CANDIDATE_TEST_FAILED", `the page requested ${p}`);
					continue;
				}
				if (!allowed.has(p))
					throw new CheckFailure("CANDIDATE_TEST_FAILED", `the page requested ${p}, which nothing declared`);
				if (r.resourceType === "script" && p !== session.moduleUrl)
					throw new CheckFailure("DUPLICATE_RUNTIME", `the page loaded ${p} as a script`);
				if (r.failure) throw new CheckFailure("CANDIDATE_TEST_FAILED", `the request of ${p} failed: ${r.failure}`);
			}
			if (observed.pageErrors.length)
				throw new CheckFailure("CANDIDATE_TEST_FAILED", `uncaught in the page: ${observed.pageErrors.join("; ")}`);
			if (observed.elementCount === 0)
				throw new CheckFailure("CANDIDATE_TEST_FAILED", "the component rendered no element");
			const missingText = Object.entries(observed.textPresent)
				.filter(([, ok]) => !ok)
				.map(([t]) => t);
			if (missingText.length)
				throw new CheckFailure("CANDIDATE_TEST_FAILED", `the rendered text lacks ${JSON.stringify(missingText[0])}`);
			if (session.nonceField && !observed.nonce.rendered)
				throw new CheckFailure(
					"CANDIDATE_TEST_FAILED",
					`the host's React did not render the observer's ${session.nonceField} through Puck's Render`,
				);
			// The defined interaction outcome (fixed fixture): a real click must
			// advance the counter attribute by the required amount. An empty
			// onClick or a missing state transition leaves it unchanged and fails
			// here; this is required only when the profile names a counter
			// attribute, so it never demands that every component's click change
			// the DOM.
			if (session.interaction) {
				const i = observed.interaction;
				if (i.buttons === 0)
					throw new CheckFailure("CANDIDATE_TEST_FAILED", "the component rendered no interactive button to test");
				if (!i.clicked)
					throw new CheckFailure("CANDIDATE_TEST_FAILED", "the component's button did not accept a real click");
				if (!i.transitioned)
					throw new CheckFailure(
						"CANDIDATE_TEST_FAILED",
						`the click did not advance ${session.interaction.counterAttribute} from ${i.before ?? "?"} by ${session.interaction.increment} (saw ${i.after ?? "?"})`,
					);
			}
			if (observed.undeclaredStylesheets.length)
				throw new CheckFailure(
					"MISSING_CSS",
					`the document holds undeclared styles: ${observed.undeclaredStylesheets.join(", ")}`,
				);
			if (observed.stylesheets.length !== session.cssUrls.length)
				throw new CheckFailure("MISSING_CSS", "a declared stylesheet is not part of the document");
			for (const sheet of observed.stylesheets) {
				if (!sheet.sameAsShipped)
					throw new CheckFailure("MISSING_CSS", `${sheet.href} in the document differs from the shipped stylesheet`);
				if (sheet.matchedRules === 0)
					throw new CheckFailure("MISSING_CSS", `no rule of ${sheet.href} applies to the rendered component`);
				// A loaded, selector-matching stylesheet is not enough: at least
				// one of its matched rules must actually take effect in the
				// browser's computed style. Disabling the stylesheet drops every
				// computed value back to the default, so nothing is in force and
				// this fails — a downloaded file and a matching selector on their
				// own never establish that a style applied.
				if (sheet.effectiveRules === 0)
					throw new CheckFailure("MISSING_CSS", `no rule of ${sheet.href} takes effect on the rendered component`);
				if (sheet.disabled)
					throw new CheckFailure("MISSING_CSS", `${sheet.href} is disabled in the document and takes no effect`);
				for (const imp of sheet.imports)
					if (!imp.loaded || !allowed.has(imp.href))
						throw new CheckFailure("MISSING_CSS", `${sheet.href} imports ${imp.href}, which did not load as declared`);
				for (const r of sheet.resources) {
					if (!allowed.has(r.url))
						throw new CheckFailure(
							"MISSING_CSS",
							`${sheet.href} references ${r.url}, which the static review did not find`,
						);
					if (!r.loaded)
						throw new CheckFailure("MISSING_CSS", `resource ${r.url} referenced by ${sheet.href} did not load`);
				}
			}
		});
	} else {
		checks.push({ name: "browser-host", status: "not_run", detail: "not enabled for this run" });
	}

	// The protected fixtures again, after use.
	const fixturesAfter = protectedFixtureDigests(profiles, fixturesRoot);
	if (Object.entries(profiles.validator.protectedFixtures).some(([rel, d]) => fixturesAfter[rel] !== d)) {
		const f = new CheckFailure("PROTECTED_FIXTURE_ALTERED", "a protected fixture changed during the run");
		checks.push({ name: "protected-fixtures-after", status: "fail", failureCode: f.code, detail: f.message });
		failure = f;
	} else {
		checks.push({ name: "protected-fixtures-after", status: "pass" });
	}

	const bindings: CertificationBindings = {
		componentId: decl.componentId,
		puckType: decl.puckType,
		sourceRevision: source.manifest.sourceRevision,
		sourceDigest: source.manifest.manifestDigest,
		packageName: source.packageName,
		version: source.packageVersion,
		buildProfileId: profiles.build.profileId,
		buildProfileDigest: profiles.build.profileDigest,
		validatorProfileId: profiles.validator.profileId,
		validatorProfileDigest: profiles.validator.profileDigest,
		hostAbi: profiles.host.hostAbi,
		hostAbiDigest: profiles.host.profileDigest,
		npm: { digest: npmDigest, sizeBytes: sequence(tarBytes.byteLength) },
		browser: { digest: moduleDigest, sizeBytes: sequence(moduleBytes.byteLength) },
		css,
		declarations,
		resources,
		protectedFixtures: fixturesBefore,
		...(bundles ? { hostBundles: bundles.digests } : {}),
		toolchain: input.toolchain,
	};
	// Completeness: the profile's mandatory checks, every one passed in
	// this run. A skipped or unknown mandatory check leaves no failure of
	// the candidate behind, but no certification either: the observer did
	// not complete, and a diagnostic run must not read as a certified one.
	const mandatory = [...profiles.validator.checks];
	const notPassed = mandatory.filter((name) => checks.find((c) => c.name === name)?.status !== "pass");
	const complete = notPassed.length === 0 && !failure;
	if (!failure && notPassed.length) {
		failure = new CheckFailure(
			"OBSERVER_FAILED",
			`mandatory check(s) not run: ${notPassed.join(", ")}; a run that skips a mandatory check is diagnostic, not a certification`,
		);
	}
	const doc: Omit<Certification, "evidenceDigest"> = {
		schemaVersion: 1,
		verdict: failure ? verdictFor(profiles, failure.code) : "certified",
		...(failure ? { failureCode: failure.code } : {}),
		complete,
		mandatoryChecks: mandatory,
		checks,
		bindings,
		npmEntries: entries.map((e) => ({ path: e.path, digest: e.digest, sizeBytes: e.sizeBytes })),
		browser: { imports: browserImports, exports: browserExports },
		host,
		steps,
		startedAt,
		completedAt: now().toISOString(),
	};
	return { ...doc, evidenceDigest: canonicalDigest(doc) };
}

/**
 * What an existing certification must match for reuse: a complete
 * certified run whose every mandatory check (the current profile's list)
 * passed, its evidence digest intact, and every binding exactly.
 */
export function certificationBinds(
	cert: Certification,
	current: Pick<
		CertificationBindings,
		"sourceDigest" | "buildProfileDigest" | "validatorProfileDigest" | "hostAbiDigest" | "npm" | "browser" | "css"
	> & { mandatoryChecks?: string[] },
): boolean {
	const b = cert.bindings;
	if (cert.verdict !== "certified" || cert.complete !== true) return false;
	if (canonicalDigest({ ...cert, evidenceDigest: undefined }) !== cert.evidenceDigest) return false;
	for (const name of current.mandatoryChecks ?? cert.mandatoryChecks) {
		if (cert.checks.find((c) => c.name === name)?.status !== "pass") return false;
	}
	return (
		b.sourceDigest === current.sourceDigest &&
		b.buildProfileDigest === current.buildProfileDigest &&
		b.validatorProfileDigest === current.validatorProfileDigest &&
		b.hostAbiDigest === current.hostAbiDigest &&
		b.npm.digest === current.npm.digest &&
		b.npm.sizeBytes === current.npm.sizeBytes &&
		b.browser.digest === current.browser.digest &&
		b.browser.sizeBytes === current.browser.sizeBytes &&
		canonicalDigest(b.css) === canonicalDigest(current.css)
	);
}
