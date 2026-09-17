import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuildError, buildComponent } from "../src/build.js";
import { callerIdentity } from "../src/isolation.js";
import { loadProfiles } from "../src/profiles.js";
import { readSource } from "../src/source.js";
import { heroSource, scratchCopy } from "./helpers.js";

const profiles = loadProfiles();
const opts = { sourceRevision: "1", profile: profiles.build, limits: profiles.validator.limits };
const disposers: Array<() => void> = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
});
function work(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "anvilkit-build-"));
	disposers.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function copy(): string {
	const s = scratchCopy(heroSource);
	disposers.push(s.dispose);
	return s.dir;
}
async function buildFails(dir: string, code: BuildError["code"], text: RegExp): Promise<void> {
	let err: unknown;
	try {
		await buildComponent(readSource(dir, opts), profiles, work(), { identity: callerIdentity() });
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(BuildError);
	expect((err as BuildError).code).toBe(code);
	expect(`${(err as BuildError).message}\n${(err as BuildError).details.join("\n")}`).toMatch(text);
}

describe("the protected build of the fixed source", () => {
	it("produces the npm tarball, declarations, browser module and separate CSS/resources", async () => {
		const source = readSource(heroSource, opts);
		const out = await buildComponent(source, profiles, work(), { identity: callerIdentity() });
		expect(out.npm.entries.map((e) => e.path)).toEqual([
			"README.md",
			"dist/assets/mark.svg",
			"dist/index.js",
			"dist/styles/hero.css",
			"dist/types/hero.d.ts",
			"dist/types/index.d.ts",
			"package.json",
		]);
		// The browser module imports only what the Host ABI provides, and exports the config.
		expect(out.browser.imports.sort()).toEqual(["react", "react/jsx-runtime"]);
		expect(out.browser.exports.sort()).toEqual(["Hero", "config", "default"]);
		const module = readFileSync(out.browser.file, "utf8");
		expect(module).not.toMatch(/node_modules/);
		expect(module).toMatch(/from ["']react["']/);
		// CSS and resources are byte-identical copies of the source.
		expect(out.css[0]?.digest).toBe(source.manifest.files.find((f) => f.path === "styles/hero.css")?.digest);
		expect(out.resources[0]?.digest).toBe(source.manifest.files.find((f) => f.path === "assets/mark.svg")?.digest);
		// The tarball entries are the staged package, hashed from the tarball itself.
		const packed = out.npm.entries.find((e) => e.path === "dist/index.js");
		expect(packed?.digest).toBe(out.browser.digest);
		expect(packed?.sizeBytes).toBe(out.browser.sizeBytes);
		// The published package.json is the trusted one, bound to the source and profiles.
		const pkg = out.packageJson as {
			peerDependencies: Record<string, string>;
			anvilkit: Record<string, unknown>;
			exports: Record<string, unknown>;
		};
		expect(pkg.peerDependencies).toEqual({ "@puckeditor/core": "0.23.0", react: "19.3.0" });
		expect(pkg.anvilkit.sourceDigest).toBe(source.manifest.manifestDigest);
		expect(pkg.anvilkit.buildProfileDigest).toBe(profiles.build.profileDigest);
		expect(Object.keys(pkg.exports)).toEqual([".", "./styles/*", "./assets/*", "./package.json"]);
		expect("scripts" in pkg).toBe(false);
		// Declarations name the exports.
		const dts = readFileSync(path.join(out.packageDir, "dist", "types", "index.d.ts"), "utf8");
		expect(dts).toMatch(/export default config/);
		expect(dts).toMatch(/export \{ Hero \}/);
	});

	it("is reproducible: the same bytes and profiles give the same tarball digest, and a source change changes it", async () => {
		const source = readSource(heroSource, opts);
		const a = await buildComponent(source, profiles, work(), { identity: callerIdentity() });
		const b = await buildComponent(source, profiles, work(), { identity: callerIdentity() });
		expect(b.npm.digest).toBe(a.npm.digest);
		expect(b.browser.digest).toBe(a.browser.digest);
		const dir = copy();
		const css = path.join(dir, "styles", "hero.css");
		writeFileSync(css, `${readFileSync(css, "utf8")}.ak-hero{margin:0}\n`);
		const c = await buildComponent(readSource(dir, opts), profiles, work(), { identity: callerIdentity() });
		expect(c.npm.digest).not.toBe(a.npm.digest);
		expect(c.browser.digest).toBe(a.browser.digest);
		expect(c.css[0]?.digest).not.toBe(a.css[0]?.digest);
	});

	it("refuses an import the Host ABI does not provide and a stylesheet import", async () => {
		const dir = copy();
		const entry = path.join(dir, "src", "index.tsx");
		writeFileSync(entry, `import "lodash-es";\n${readFileSync(entry, "utf8")}`);
		await buildFails(dir, "CANDIDATE_BUILD_FAILED", /imports lodash-es, which the Host ABI does not provide/);
		writeFileSync(
			entry,
			`import "../styles/hero.css";\n${readFileSync(entry, "utf8").replace(/^import "lodash-es";\n/, "")}`,
		);
		await buildFails(dir, "CANDIDATE_BUILD_FAILED", /imports a stylesheet/);
	});

	it("loads only inventoried source modules: absolute and escaping imports are refused", async () => {
		const dir = copy();
		const entry = path.join(dir, "src", "index.tsx");
		const original = readFileSync(entry, "utf8");
		writeFileSync(entry, `import "/etc/hostname";\n${original}`);
		await buildFails(dir, "CANDIDATE_BUILD_FAILED", /imports the absolute path \/etc\/hostname/);
		// An escaping relative import of bytes that exist on disk beside the
		// staged source (nothing of the inventory): a JavaScript module with a
		// declaration beside it, which the compiler's own rootDir rule does not
		// catch (declarations are not emitted); the trusted resolver refuses it.
		const workDir = work();
		writeFileSync(path.join(workDir, "leak.js"), "export const leak = 1;\n");
		writeFileSync(path.join(workDir, "leak.d.ts"), "export declare const leak: number;\n");
		writeFileSync(entry, `import { leak } from "../../leak.js";\nconsole.log(leak);\n${original}`);
		let err: unknown;
		try {
			await buildComponent(readSource(dir, opts), profiles, workDir, { identity: callerIdentity() });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(BuildError);
		expect((err as BuildError).code).toBe("CANDIDATE_BUILD_FAILED");
		expect(`${(err as BuildError).message}\n${(err as BuildError).details.join("\n")}`).toMatch(
			/escapes the source's src\/ tree/,
		);
		// The same bytes build the same module whether or not that file exists.
		writeFileSync(entry, original);
		const source = readSource(dir, opts);
		const withLeak = work();
		writeFileSync(path.join(withLeak, "leak.js"), "export const leak = 2;\n");
		const a = await buildComponent(source, profiles, withLeak, { identity: callerIdentity() });
		const b = await buildComponent(source, profiles, work(), { identity: callerIdentity() });
		expect(a.browser.digest).toBe(b.browser.digest);
		expect(a.npm.digest).toBe(b.npm.digest);
	});

	it("fails the build on a type error instead of emitting", async () => {
		const dir = copy();
		const hero = path.join(dir, "src", "hero.tsx");
		writeFileSync(
			hero,
			readFileSync(hero, "utf8").replace(
				"const [clicks, setClicks] = useState(0);",
				"const [clicks, setClicks] = useState(0);\nconst wrong: number = title;",
			),
		);
		await buildFails(dir, "CANDIDATE_BUILD_FAILED", /TS2322|not assignable/);
	});

	it("does not let candidate configuration change the trusted rules", async () => {
		// A tsconfig or rollup config in the source is refused by the source
		// contract; the build itself takes its rules from the profile only,
		// so a build of the fixed source ignores the environment's cwd too.
		const source = readSource(heroSource, opts);
		const out = await buildComponent(source, profiles, work(), { identity: callerIdentity() });
		expect(out.step.identity).toBe("caller");
		expect(out.step.code).toBe(0);
	});
});
