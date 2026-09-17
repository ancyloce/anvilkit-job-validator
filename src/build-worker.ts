// The build step (DD-04 §2), run as a child process by build.ts: Rollup with
// the TypeScript plugin over the read-only source copy, configured entirely
// from the trusted build configuration file it is given. It reads candidate
// files as data, never imports them, resolves only the externals the Host
// ABI provides (everything else bare is a refusal), refuses stylesheet
// imports (styles are separate by contract), and lets Rollup load nothing
// but the inventoried source modules: every module id that reaches the
// bundle is a real path under the staged src/ tree whose bytes are the
// inventory's (absolute ids, escaping relative ids, virtual ids and any
// other byte on the filesystem are refused, so the same source bytes and
// profiles build the same module whatever else changed on disk). The
// externals' type declarations come from the trusted install through the
// TypeScript plugin's own resolution and never enter the bundle. It emits
// one ESM chunk and the declarations and writes a result document the
// orchestrator reads. Its exit code is data to the orchestrator; the
// orchestrator inspects the files it produced.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import typescriptPlugin from "@rollup/plugin-typescript";
import { type OutputChunk, type RollupLog, rollup } from "rollup";

export interface BuildConfig {
	sourceDir: string;
	entry: string;
	outDir: string;
	externals: string[];
	/** The trusted tsconfig the orchestrator wrote (compiler options and the source include). */
	tsconfig: string;
	/** The inventoried code modules (source-relative path under src/ → sha256 digest); nothing else is loadable. */
	inventory: Record<string, string>;
}

export interface BuildResult {
	ok: boolean;
	kind?: "candidate" | "infrastructure";
	error?: string;
	diagnostics: string[];
	warnings: string[];
	chunk?: { fileName: string; imports: string[]; exports: string[]; dynamicImports: string[] };
	emitted: string[];
}

const require = createRequire(import.meta.url);

// The plugin's types are CommonJS-shaped (default under module.exports)
// while Node resolves its "import" condition to an ES module whose default
// export is the function itself; both runtime shapes are accepted here.
type TypescriptPlugin = typeof typescriptPlugin.default;
const typescript: TypescriptPlugin =
	typeof typescriptPlugin === "function" ? (typescriptPlugin as unknown as TypescriptPlugin) : typescriptPlugin.default;

async function main(): Promise<void> {
	const [configPath, resultPath] = process.argv.slice(2);
	if (!configPath || !resultPath) throw new Error("usage: build-worker <config.json> <result.json>");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as BuildConfig;
	const result: BuildResult = { ok: false, diagnostics: [], warnings: [], emitted: [] };
	const externals = new Set(config.externals);
	const bare = (id: string) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0");
	const sourceRoot = realpathSync(config.sourceDir);
	const codeRoot = path.join(sourceRoot, "src");
	const entryPath = path.join(sourceRoot, config.entry);
	/** The inventory path of a resolved module id, or a refusal message. */
	const inventoried = (id: string): { rel: string } | { refusal: string } => {
		if (id.startsWith("\0")) return { refusal: `virtual module ${id.slice(1)} is not part of the source` };
		let real: string;
		try {
			real = realpathSync(id);
		} catch {
			return { refusal: `${id} is not a file of the source` };
		}
		if (real !== id) return { refusal: `${id} is a link, not a source file` };
		if (!real.startsWith(`${codeRoot}${path.sep}`)) return { refusal: `${id} is outside the source's src/ tree` };
		const rel = path.relative(sourceRoot, real).split(path.sep).join("/");
		if (!(rel in config.inventory)) return { refusal: `${rel} is not an inventoried source file` };
		return { rel };
	};
	try {
		const bundle = await rollup({
			input: path.join(config.sourceDir, config.entry),
			external: (id) => externals.has(id),
			treeshake: true,
			onwarn(log: RollupLog) {
				result.warnings.push(`${log.code ?? "WARNING"}: ${log.message}`);
			},
			plugins: [
				{
					name: "anvilkit-trusted-resolver",
					resolveId(id, importer) {
						if (importer === undefined) {
							if (id !== entryPath) throw new Error(`the build's input ${id} is not the declared entry`);
							return null;
						}
						if (id.endsWith(".css")) {
							throw new Error(
								`${importer} imports a stylesheet (${id}); styles are delivered separately and never imported by code`,
							);
						}
						if (externals.has(id)) return null;
						if (bare(id)) {
							throw new Error(
								`${importer} imports ${id}, which the Host ABI does not provide and the profile does not bundle`,
							);
						}
						if (id.startsWith("\0")) throw new Error(`${importer} imports the virtual module ${id.slice(1)}`);
						if (path.isAbsolute(id) || id.startsWith("/"))
							throw new Error(
								`${importer} imports the absolute path ${id}; only relative imports of inventoried source files are accepted`,
							);
						// A relative id: it must stay inside the staged src/ tree before any
						// extension probing; the load hook decides on the resolved file.
						const target = path.resolve(path.dirname(importer), id);
						if (target !== codeRoot && !target.startsWith(`${codeRoot}${path.sep}`))
							throw new Error(`${importer} imports ${id}, which escapes the source's src/ tree`);
						return null;
					},
					load(id) {
						const found = inventoried(id);
						if ("refusal" in found) throw new Error(`refused to load ${found.refusal}`);
						const bytes = readFileSync(id);
						const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
						if (digest !== config.inventory[found.rel])
							throw new Error(`refused to load ${found.rel}: its bytes are not the inventoried bytes`);
						return null;
					},
				},
				typescript({
					tsconfig: config.tsconfig,
					noEmitOnError: true,
					tslib: require.resolve("tslib"),
					compilerOptions: { outDir: config.outDir, declarationDir: path.join(config.outDir, "types") },
				}),
			],
		});
		const out = await bundle.write({
			dir: config.outDir,
			format: "es",
			entryFileNames: "index.js",
			chunkFileNames: "chunk-[hash].js",
			sourcemap: false,
			exports: "named",
			generatedCode: "es2015",
			compact: false,
		});
		await bundle.close();
		const chunks = out.output.filter((o): o is OutputChunk => o.type === "chunk");
		result.emitted = out.output.map((o) => o.fileName).sort();
		if (chunks.length !== 1 || chunks[0]?.fileName !== "index.js") {
			result.kind = "candidate";
			result.error = `expected one chunk index.js, got ${chunks.map((c) => c.fileName).join(", ")}`;
		} else {
			const c = chunks[0];
			result.chunk = {
				fileName: c.fileName,
				imports: [...c.imports],
				exports: [...c.exports],
				dynamicImports: [...c.dynamicImports],
			};
			result.ok = true;
		}
	} catch (err) {
		const e = err as Error & { plugin?: string; code?: string; frame?: string; loc?: { file?: string; line?: number } };
		result.kind = "candidate";
		result.error = `${e.code ?? e.name}: ${e.message}`;
		if (e.frame) result.diagnostics.push(e.frame);
		if (e.loc?.file) result.diagnostics.push(`${e.loc.file}:${e.loc.line ?? 0}`);
	}
	writeFileSync(resultPath, JSON.stringify(result));
	process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
	const resultPath = process.argv[3];
	if (resultPath) {
		writeFileSync(
			resultPath,
			JSON.stringify({
				ok: false,
				kind: "infrastructure",
				error: String((err as Error).stack ?? err),
				diagnostics: [],
				warnings: [],
				emitted: [],
			}),
		);
	}
	process.exit(2);
});
