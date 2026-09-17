// The host side of the browser fixture (DD-04 §3, DD-05 §3): one ESM bundle
// per Host ABI external (react, react/jsx-runtime, react-dom,
// react-dom/client, @puckeditor/core) from this package's locked install,
// each importing the others by bare specifier so the page's import map
// leaves exactly one instance of each, plus the compiled protected host
// script. Built by trusted code with the Rollup profile's plugins, cached
// under fixtures/host/browser/dist keyed by its inputs, digested into the
// certification evidence. No candidate byte is involved here.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import commonjsPlugin from "@rollup/plugin-commonjs";
import nodeResolvePlugin from "@rollup/plugin-node-resolve";
import replacePlugin from "@rollup/plugin-replace";
import typescriptPlugin from "@rollup/plugin-typescript";
import { type Plugin, rollup } from "rollup";
import { canonicalDigest, type Digest, sha256 } from "./digest.js";
import { loadProfiles, type Profiles, packageRoot, verifyToolchain } from "./profiles.js";

type Callable<T> = T extends (...a: infer A) => infer R
	? (...a: A) => R
	: T extends { default: infer D }
		? Callable<D>
		: never;
function callable<T>(m: T): Callable<T> {
	const anyM = m as unknown as { default?: unknown };
	return (typeof m === "function" ? m : anyM.default) as Callable<T>;
}
const commonjs = callable(commonjsPlugin);
const nodeResolve = callable(nodeResolvePlugin);
const replace = callable(replacePlugin);
const typescript = callable(typescriptPlugin);

export const hostFixtureDir = path.join(packageRoot, "fixtures", "host", "browser");
export const hostBundleDir = path.join(hostFixtureDir, "dist");

/** Bundle file name of a Host ABI specifier, as the protected page's import map names it. */
export function bundleName(specifier: string): string {
	if (specifier === "@puckeditor/core") return "puck.js";
	return `${specifier.replace(/^@/, "").replace(/[/]/g, "-")}.js`;
}

export interface HostBundles {
	dir: string;
	/** Digests by file name (react.js, host.js, …). */
	digests: Record<string, Digest>;
	/** Digest of the inputs that produced them. */
	inputsDigest: Digest;
}

function virtual(id: string, code: string): Plugin {
	return {
		name: "anvilkit-virtual-entry",
		resolveId: (source) => (source === id ? id : null),
		load: (loaded) => (loaded === id ? code : null),
	};
}

/** Export names of a trusted package as this Node resolves them (never a candidate's). */
async function exportNames(specifier: string): Promise<string[]> {
	const ns = (await import(specifier)) as Record<string, unknown>;
	return Object.keys(ns)
		.filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n))
		.sort();
}

async function bundleExternal(specifier: string, externals: string[], outFile: string): Promise<void> {
	const entry = "\0anvilkit-host-entry";
	const others = externals.filter((e) => e !== specifier);
	const names = await exportNames(specifier);
	const build = async (code: string) => {
		const bundle = await rollup({
			input: entry,
			external: (id) => others.includes(id),
			onwarn: () => {},
			plugins: [
				virtual(entry, code),
				replace({ preventAssignment: true, values: { "process.env.NODE_ENV": JSON.stringify("production") } }),
				nodeResolve({
					browser: true,
					preferBuiltins: false,
					exportConditions: ["browser", "import", "module", "default"],
				}),
				commonjs({ defaultIsModuleExports: "auto" }),
			],
		});
		await bundle.write({ file: outFile, format: "es", sourcemap: false, exports: "named", inlineDynamicImports: true });
		await bundle.close();
	};
	const spec = JSON.stringify(specifier);
	try {
		// A CommonJS package (React, ReactDOM): module.exports is the default
		// and every export name is re-exported from it, so the page's
		// import map serves one instance with the names the module expects.
		await build(
			`import m from ${spec};\nexport default m;\n${names.map((n) => `export const ${n} = m.${n};`).join("\n")}\n`,
		);
	} catch (err) {
		if (!String((err as Error).message).includes('"default" is not exported')) throw err;
		// An ES package (Puck): its own named exports.
		await build(`export * from ${spec};\n`);
	}
}

async function bundleHost(externals: string[], outFile: string): Promise<void> {
	const bundle = await rollup({
		input: path.join(hostFixtureDir, "host.tsx"),
		external: (id) => externals.includes(id),
		onwarn: () => {},
		plugins: [
			typescript({
				tsconfig: false,
				include: [`${hostFixtureDir}/host.tsx`],
				noEmitOnError: true,
				compilerOptions: {
					target: "es2022",
					lib: ["es2022", "dom", "dom.iterable"],
					module: "esnext",
					moduleResolution: "bundler",
					jsx: "react-jsx",
					strict: true,
					isolatedModules: true,
					skipLibCheck: true,
					declaration: false,
					sourceMap: false,
					types: [],
					noEmit: false,
				},
			}),
		],
	});
	await bundle.write({ file: outFile, format: "es", sourcemap: false });
	await bundle.close();
}

/** Builds (or reuses) the host bundles for the profiles' Host ABI. */
export async function ensureHostBundles(profiles: Profiles, toolchain: Record<string, string>): Promise<HostBundles> {
	const externals = Object.keys(profiles.host.externals).sort();
	const inputs = {
		hostAbi: profiles.host.profileDigest,
		hostScript: sha256(readFileSync(path.join(hostFixtureDir, "host.tsx"))),
		toolchain,
		builder: sha256(readFileSync(new URL(import.meta.url))),
	};
	const inputsDigest = canonicalDigest(inputs);
	const manifestPath = path.join(hostBundleDir, "manifest.json");
	const expected = [...externals.map(bundleName), "host.js"];
	if (existsSync(manifestPath)) {
		try {
			const m = JSON.parse(readFileSync(manifestPath, "utf8")) as HostBundles;
			if (
				m.inputsDigest === inputsDigest &&
				expected.every(
					(f) =>
						existsSync(path.join(hostBundleDir, f)) &&
						sha256(readFileSync(path.join(hostBundleDir, f))) === m.digests[f],
				)
			) {
				return { dir: hostBundleDir, digests: m.digests, inputsDigest };
			}
		} catch {
			// rebuild
		}
	}
	mkdirSync(hostBundleDir, { recursive: true });
	for (const f of readdirSync(hostBundleDir))
		if (f.endsWith(".js") || f === "manifest.json") unlinkSync(path.join(hostBundleDir, f));
	for (const specifier of externals)
		await bundleExternal(specifier, externals, path.join(hostBundleDir, bundleName(specifier)));
	await bundleHost(externals, path.join(hostBundleDir, "host.js"));
	const digests: Record<string, Digest> = {};
	for (const f of expected) digests[f] = sha256(readFileSync(path.join(hostBundleDir, f)));
	const out: HostBundles = { dir: hostBundleDir, digests, inputsDigest };
	writeFileSync(manifestPath, JSON.stringify(out, null, 2));
	return out;
}

// `node dist/host-bundles.js` (or `tsx src/host-bundles.ts`) builds the
// bundles for the reviewed profiles ahead of time: the image runs on a
// read-only filesystem, so the trusted process must find them built and
// reuse them (the manifest binds the Host ABI digest, the host script, the
// toolchain and this builder; anything else is rebuilt, which the image
// cannot do and reports as an observer failure).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const profiles = loadProfiles(process.argv[2]);
	const bundles = await ensureHostBundles(profiles, verifyToolchain(profiles));
	console.log(JSON.stringify({ dir: bundles.dir, inputsDigest: bundles.inputsDigest, digests: bundles.digests }));
}
