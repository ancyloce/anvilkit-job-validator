// The protected build (DD-04 §2): from the inventoried source bytes and the
// exact profiles to an npm tarball, declarations, one browser ESM module
// and the separate CSS/resources, with the actual inventories, digests and
// sizes of everything produced. Configuration comes from this code and the
// profiles alone: the candidate's rollup/vite/tsconfig/postcss files never
// reach the build (source.ts already refuses them), its package.json never
// becomes the published one, and no lifecycle script of any package runs.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { BuildConfig, BuildResult } from "./build-worker.js";
import { type Digest, sequence, sha256 } from "./digest.js";
import { runStep, type StepIdentity, type StepOutcome, workerArgv } from "./isolation.js";
import { type Profiles, packageRoot } from "./profiles.js";
import type { SourceRead } from "./source.js";
import { readTarball, type TarEntry, writeTarball } from "./tarball.js";

export interface ArtifactFile {
	path: string;
	digest: Digest;
	sizeBytes: string;
}

export interface BuildOutput {
	workDir: string;
	/** The package as staged for publication (package/ of the tarball). */
	packageDir: string;
	packageJson: Record<string, unknown>;
	npm: { file: string; name: string; version: string; digest: Digest; sizeBytes: string; entries: TarEntry[] };
	browser: ArtifactFile & { file: string; imports: string[]; exports: string[] };
	declarations: ArtifactFile[];
	css: Array<ArtifactFile & { file: string }>;
	resources: ArtifactFile[];
	step: StepOutcome & { identity: StepIdentity["mode"]; warnings: string[] };
}

export class BuildError extends Error {
	constructor(
		readonly code: "CANDIDATE_BUILD_FAILED" | "OBSERVER_FAILED" | "DEADLINE_EXCEEDED",
		message: string,
		readonly details: string[] = [],
	) {
		super(message);
	}
}

export interface BuildOptions {
	identity: StepIdentity;
	timeoutMs?: number;
}

/** Writes the inventoried bytes as a read-only tree the build step may read and never change. */
function stageSource(source: SourceRead, dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const [rel, bytes] of source.files) {
		const abs = path.join(dir, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, bytes, { mode: 0o444 });
	}
	const lock = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) lock(path.join(d, e.name));
		chmodSync(d, 0o555);
	};
	lock(dir);
}

function listFiles(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const p = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), p));
		else if (e.isFile()) out.push(p);
		else throw new BuildError("CANDIDATE_BUILD_FAILED", `${p}: the build left a non-regular file`);
	}
	return out;
}

function fileEntry(root: string, rel: string): ArtifactFile {
	const bytes = readFileSync(path.join(root, rel));
	return { path: rel, digest: sha256(bytes), sizeBytes: sequence(bytes.byteLength) };
}

/** The published package.json: the trusted publication contract, not the candidate's file. */
export function publishedPackageJson(
	source: SourceRead,
	profiles: Profiles,
	declarationFiles: string[],
): Record<string, unknown> {
	const decl = source.declaration;
	const peer: Record<string, string> = {};
	for (const name of Object.keys(source.manifest.dependencies).sort())
		peer[name] = source.manifest.dependencies[name] as string;
	const exportsMap: Record<string, unknown> = { ".": { types: "./dist/types/index.d.ts", import: "./dist/index.js" } };
	if (decl.styles.length) exportsMap["./styles/*"] = "./dist/styles/*";
	if (decl.resources.length) exportsMap["./assets/*"] = "./dist/assets/*";
	exportsMap["./package.json"] = "./package.json";
	const pkg = JSON.parse((source.files.get("package.json") as Buffer).toString("utf8")) as Record<string, unknown>;
	return {
		name: source.packageName,
		version: source.packageVersion,
		...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
		...(typeof pkg.license === "string" ? { license: pkg.license } : {}),
		type: "module",
		sideEffects: false,
		main: "./dist/index.js",
		module: "./dist/index.js",
		types: "./dist/types/index.d.ts",
		exports: exportsMap,
		files: ["dist", decl.usage],
		peerDependencies: peer,
		anvilkit: {
			schemaVersion: 1,
			componentId: decl.componentId,
			puckType: decl.puckType,
			sourceRevision: source.manifest.sourceRevision,
			sourceDigest: source.manifest.manifestDigest,
			buildProfileId: profiles.build.profileId,
			buildProfileDigest: profiles.build.profileDigest,
			hostAbi: profiles.host.hostAbi,
			hostAbiDigest: profiles.host.profileDigest,
			styles: decl.styles.map((s) => `dist/${s}`),
			resources: decl.resources.map((r) => `dist/${r}`),
			declarations: declarationFiles,
		},
	};
}

export async function buildComponent(
	source: SourceRead,
	profiles: Profiles,
	workDir: string,
	opts: BuildOptions,
): Promise<BuildOutput> {
	const limits = profiles.validator.limits;
	const sourceDir = path.join(workDir, "source");
	const outDir = path.join(workDir, "out");
	const stageDir = path.join(workDir, "stage");
	const packageDir = path.join(stageDir, "package");
	mkdirSync(workDir, { recursive: true });
	chmodSync(workDir, 0o755);
	stageSource(source, sourceDir);
	// The trusted install is what the TypeScript resolution of the step
	// sees for the externals' types; nothing of the candidate is on that
	// path and the link is only traversed, never written.
	symlinkSync(path.join(packageRoot, "node_modules"), path.join(workDir, "node_modules"), "dir");
	// The step's output and scratch directories: created by the trusted
	// process (which holds no CAP_CHOWN in the Job) as world-writable
	// entries of the root-owned work tree, so the step identity can write
	// into them and nothing else of the tree; the orchestrator reads what
	// the step left there as data.
	const home = path.join(workDir, "home");
	for (const dir of [outDir, home]) {
		mkdirSync(dir);
		chmodSync(dir, 0o1777);
	}

	// The compiler configuration is this code's, not the candidate's: the
	// candidate's tsconfig (if any) was refused by the source contract.
	const tsconfigPath = path.join(workDir, "tsconfig.trusted.json");
	writeFileSync(
		tsconfigPath,
		JSON.stringify({
			compilerOptions: {
				target: "es2022",
				lib: ["es2022", "dom"],
				module: "esnext",
				moduleResolution: "bundler",
				jsx: "react-jsx",
				jsxImportSource: "react",
				strict: true,
				isolatedModules: true,
				importHelpers: false,
				skipLibCheck: true,
				declaration: true,
				declarationDir: path.join(outDir, "types"),
				outDir,
				rootDir: path.join(sourceDir, "src"),
				types: [],
				sourceMap: false,
				allowJs: false,
				resolveJsonModule: false,
			},
			include: ["source/src/**/*.ts", "source/src/**/*.tsx"],
			exclude: [],
		}),
		{ mode: 0o444 },
	);
	// The inventory the step may load: the code modules under src/ with
	// the digests of their inventoried bytes (styles, resources and the
	// declaration are data of the orchestrator, never modules).
	const inventory: Record<string, string> = {};
	for (const f of source.manifest.files) if (f.path.startsWith("src/")) inventory[f.path] = f.digest;
	const config: BuildConfig = {
		sourceDir,
		entry: source.declaration.entry,
		outDir,
		externals: Object.keys(profiles.host.externals).sort(),
		tsconfig: tsconfigPath,
		inventory,
	};
	const configPath = path.join(workDir, "build-config.json");
	const resultPath = path.join(outDir, "build-result.json");
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o444 });
	const step = await runStep([...workerArgv("build-worker"), configPath, resultPath], {
		cwd: packageRoot,
		env: { HOME: home, TMPDIR: home },
		timeoutMs: opts.timeoutMs ?? limits.buildTimeoutMs,
		identity: opts.identity,
	});
	// Nothing of the step is read while a process of it may still be
	// writing: an unconfirmed stop is an observer failure, not a verdict.
	if (!step.stop.confirmed) throw new BuildError("OBSERVER_FAILED", `the build step's ${step.stop.error}`);
	if (step.timedOut)
		throw new BuildError(
			"DEADLINE_EXCEEDED",
			`the build step exceeded ${opts.timeoutMs ?? limits.buildTimeoutMs} ms and was stopped`,
		);
	let result: BuildResult | undefined;
	if (existsSync(resultPath)) {
		try {
			result = JSON.parse(readFileSync(resultPath, "utf8")) as BuildResult;
		} catch (err) {
			throw new BuildError("OBSERVER_FAILED", `build result unreadable: ${(err as Error).message}`, [step.stderr]);
		}
	}
	if (!result)
		throw new BuildError(
			"OBSERVER_FAILED",
			`the build step left no result (exit ${step.code}, signal ${step.signal})`,
			[step.stderr.slice(-4000)],
		);
	if (!result.ok) {
		if (result.kind === "candidate")
			throw new BuildError("CANDIDATE_BUILD_FAILED", result.error ?? "build failed", result.diagnostics);
		throw new BuildError("OBSERVER_FAILED", result.error ?? "build step failed", [
			...result.diagnostics,
			step.stderr.slice(-4000),
		]);
	}
	if (step.code !== 0) throw new BuildError("OBSERVER_FAILED", `build step reported ok but exited ${step.code}`);

	// What the step produced, read from disk by the orchestrator: exactly
	// index.js and the declarations under types/, nothing else.
	const produced = listFiles(outDir).filter((p) => p !== "build-result.json");
	const declarationFiles = produced.filter((p) => p.startsWith("types/") && p.endsWith(".d.ts"));
	const unexpected = produced.filter((p) => p !== "index.js" && !declarationFiles.includes(p));
	if (unexpected.length)
		throw new BuildError("CANDIDATE_BUILD_FAILED", `the build produced unexpected files: ${unexpected.join(", ")}`);
	if (!produced.includes("index.js"))
		throw new BuildError("CANDIDATE_BUILD_FAILED", "the build produced no browser module");
	if (!declarationFiles.includes("types/index.d.ts"))
		throw new BuildError("CANDIDATE_BUILD_FAILED", "the build produced no entry declaration");
	const moduleBytes = readFileSync(path.join(outDir, "index.js"));
	if (moduleBytes.byteLength > limits.maxBrowserModuleBytes) {
		throw new BuildError(
			"CANDIDATE_BUILD_FAILED",
			`browser module is ${moduleBytes.byteLength} bytes, above the bound ${limits.maxBrowserModuleBytes}`,
		);
	}

	// Stage the package: the trusted package.json, the usage file, the
	// module, the declarations, and the stylesheets and resources copied
	// byte for byte from the inventoried source (no preprocessor, no
	// rewriting; a relative url() between styles/ and assets/ keeps working).
	mkdirSync(path.join(packageDir, "dist", "types"), { recursive: true });
	copyFileSync(path.join(outDir, "index.js"), path.join(packageDir, "dist", "index.js"));
	for (const d of declarationFiles) {
		mkdirSync(path.dirname(path.join(packageDir, "dist", d)), { recursive: true });
		copyFileSync(path.join(outDir, d), path.join(packageDir, "dist", d));
	}
	const decl = source.declaration;
	let cssBytes = 0;
	for (const rel of [...decl.styles, ...decl.resources]) {
		const bytes = source.files.get(rel) as Buffer;
		if (decl.styles.includes(rel)) cssBytes += bytes.byteLength;
		const abs = path.join(packageDir, "dist", rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, bytes, { mode: 0o644 });
	}
	if (cssBytes > limits.maxCssBytes)
		throw new BuildError(
			"CANDIDATE_BUILD_FAILED",
			`stylesheets total ${cssBytes} bytes, above the bound ${limits.maxCssBytes}`,
		);
	writeFileSync(path.join(packageDir, decl.usage), source.files.get(decl.usage) as Buffer, { mode: 0o644 });
	const packageJson = publishedPackageJson(
		source,
		profiles,
		declarationFiles.map((d) => `dist/${d}`),
	);
	writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, { mode: 0o644 });
	for (const f of listFiles(packageDir)) chmodSync(path.join(packageDir, f), 0o644);

	const files = listFiles(packageDir);
	const tarballName = `${source.packageName.replace(/^@/, "").replace("/", "-")}-${source.packageVersion}.tgz`;
	const tarball = path.join(workDir, tarballName);
	await writeTarball(stageDir, files, tarball);
	const tarBytes = readFileSync(tarball);
	if (tarBytes.byteLength > limits.maxNpmTarballBytes)
		throw new BuildError(
			"CANDIDATE_BUILD_FAILED",
			`npm tarball is ${tarBytes.byteLength} bytes, above the bound ${limits.maxNpmTarballBytes}`,
		);
	const entries = await readTarball(tarball, { maxEntries: 4096, maxUncompressedBytes: limits.maxNpmTarballBytes * 8 });
	if (entries.map((e) => e.path).join("\n") !== files.join("\n")) {
		throw new BuildError("OBSERVER_FAILED", "the tarball inventory differs from the staged package");
	}
	const browser = fileEntry(packageDir, "dist/index.js");
	return {
		workDir,
		packageDir,
		packageJson,
		npm: {
			file: tarball,
			name: source.packageName,
			version: source.packageVersion,
			digest: sha256(tarBytes),
			sizeBytes: sequence(tarBytes.byteLength),
			entries,
		},
		browser: {
			...browser,
			file: path.join(packageDir, "dist", "index.js"),
			imports: result.chunk?.imports ?? [],
			exports: result.chunk?.exports ?? [],
		},
		declarations: declarationFiles.map((d) => fileEntry(packageDir, `dist/${d}`)),
		css: decl.styles.map((s) => ({ ...fileEntry(packageDir, `dist/${s}`), file: path.join(packageDir, "dist", s) })),
		resources: decl.resources.map((r) => fileEntry(packageDir, `dist/${r}`)),
		step: {
			...step,
			stdout: "",
			stderr: step.stderr.slice(-2000),
			identity: opts.identity.mode,
			warnings: result.warnings,
		},
	};
}

/** Size of a file as the contract writes it. */
export function fileSize(file: string): string {
	return sequence(statSync(file).size);
}
