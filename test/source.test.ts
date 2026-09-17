import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { componentsSchemaId, validateAgainst } from "../src/contracts.js";
import { loadProfiles } from "../src/profiles.js";
import { readSource, SourceError } from "../src/source.js";
import { heroSource, scratchCopy } from "./helpers.js";

const profiles = loadProfiles();
const opts = { sourceRevision: "1", profile: profiles.build, limits: profiles.validator.limits };
const disposers: Array<() => void> = [];
afterEach(() => {
	for (const d of disposers.splice(0)) d();
});
function copy(): string {
	const s = scratchCopy(heroSource);
	disposers.push(s.dispose);
	return s.dir;
}
function fails(dir: string, code: SourceError["code"], text: string | RegExp): void {
	let err: unknown;
	try {
		readSource(dir, opts);
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(SourceError);
	expect((err as SourceError).code).toBe(code);
	expect((err as SourceError).message).toMatch(text);
}

describe("the fixed complete source", () => {
	it("satisfies the contract with a manifest computed from the bytes", () => {
		const read = readSource(heroSource, opts);
		expect(validateAgainst(`${componentsSchemaId}#/$defs/sourceManifest`, read.manifest)).toBeUndefined();
		expect(read.manifest.entry).toBe("src/index.tsx");
		expect(read.manifest.styles).toEqual(["styles/hero.css"]);
		expect(read.manifest.dependencies).toEqual({ "@puckeditor/core": "0.23.0", react: "19.3.0" });
		expect(read.manifest.files.map((f) => f.path)).toEqual([
			"README.md",
			"assets/mark.svg",
			"component.json",
			"package.json",
			"pnpm-lock.yaml",
			"src/hero.tsx",
			"src/index.tsx",
			"styles/hero.css",
		]);
		for (const f of read.manifest.files) expect(f.sizeBytes).toBe(String(read.files.get(f.path)?.byteLength));
		expect(read.manifest.editableFields.map((f) => f.name)).toEqual(["title", "subtitle", "align", "ctaLabel"]);
		expect(read.packageName).toBe("@anvilkit/hero-fixed");
		// Deterministic: the same bytes from another directory give the same digest.
		const again = readSource(copy(), opts);
		expect(again.manifest.manifestDigest).toBe(read.manifest.manifestDigest);
		expect(again.manifest.files).toEqual(read.manifest.files);
	});

	it("changes its digest when any byte changes", () => {
		const base = readSource(heroSource, opts).manifest;
		const dir = copy();
		const css = path.join(dir, "styles", "hero.css");
		writeFileSync(css, `${readFileSync(css, "utf8")}\n.ak-hero { margin: 1px; }\n`);
		const changed = readSource(dir, opts).manifest;
		expect(changed.manifestDigest).not.toBe(base.manifestDigest);
		expect(changed.files.find((f) => f.path === "styles/hero.css")?.digest).not.toBe(
			base.files.find((f) => f.path === "styles/hero.css")?.digest,
		);
		// A revision is the caller's; it does not enter the byte digest.
		expect(readSource(dir, { ...opts, sourceRevision: "2" }).manifest.manifestDigest).toBe(changed.manifestDigest);
	});
});

describe("source refusals", () => {
	it("rejects a symbolic link that escapes the source", () => {
		const dir = copy();
		symlinkSync("/etc/passwd", path.join(dir, "src", "escape.ts"));
		fails(dir, "PATH_ESCAPE", /symbolic links are refused/);
	});
	it("rejects a link inside the source too", () => {
		const dir = copy();
		symlinkSync("hero.tsx", path.join(dir, "src", "alias.tsx"));
		fails(dir, "PATH_ESCAPE", /symbolic links are refused/);
	});
	it("rejects case aliases of one path", () => {
		const dir = copy();
		mkdirSync(path.join(dir, "Src"));
		writeFileSync(path.join(dir, "Src", "index.tsx"), "export {};\n");
		fails(dir, "PATH_ESCAPE", /case aliases/);
	});
	it("rejects special files", () => {
		const dir = copy();
		execFileSync("mkfifo", [path.join(dir, "src", "pipe.ts")]);
		fails(dir, "PATH_ESCAPE", /not a regular file/);
	});
	it("rejects a declared stylesheet that does not exist", () => {
		const dir = copy();
		const decl = JSON.parse(readFileSync(path.join(dir, "component.json"), "utf8"));
		decl.styles.push("styles/missing.css");
		writeFileSync(path.join(dir, "component.json"), JSON.stringify(decl));
		fails(dir, "CANDIDATE_BUILD_FAILED", /declared style styles\/missing.css is missing/);
	});
	it("rejects an undeclared stylesheet and an undeclared resource", () => {
		const dir = copy();
		writeFileSync(path.join(dir, "styles", "extra.css"), ".x{}\n");
		fails(dir, "CANDIDATE_BUILD_FAILED", /styles\/extra.css: stylesheet is not declared/);
		rmSync(path.join(dir, "styles", "extra.css"));
		writeFileSync(path.join(dir, "assets", "extra.svg"), "<svg/>\n");
		fails(dir, "CANDIDATE_BUILD_FAILED", /assets\/extra.svg: resource is not declared/);
	});
	it("rejects a dependency the profile does not support and a lockfile that disagrees", () => {
		const dir = copy();
		const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
		pkg.dependencies.lodash = "4.17.21";
		writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
		fails(dir, "CANDIDATE_BUILD_FAILED", /dependency lodash is not supported by profile build-support-dev-v1/);
		pkg.dependencies = { "@puckeditor/core": "0.23.0", react: "19.3.0", "react-dom": "19.3.0" };
		writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
		fails(dir, "CANDIDATE_BUILD_FAILED", /pnpm-lock.yaml: locked dependencies .* differ from the declared/);
		pkg.dependencies = { "@puckeditor/core": "0.23.0", react: "^19.0.0" };
		writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
		fails(dir, "CANDIDATE_BUILD_FAILED", /must pin an exact version/);
	});
	it("rejects package names and versions the registry and node-semver refuse, without repairing them", () => {
		const dir = copy();
		const pkgPath = path.join(dir, "package.json");
		const original = JSON.parse(readFileSync(pkgPath, "utf8"));
		const withPackage = (edit: (pkg: Record<string, unknown>) => void) => {
			const pkg = structuredClone(original);
			edit(pkg);
			writeFileSync(pkgPath, JSON.stringify(pkg));
		};
		for (const [name, text] of [
			["favicon.ico", /name favicon.ico is not a valid package name/],
			["a~b", /name can no longer contain special characters/],
			["node_modules", /not a valid package name/],
			["@Scope/x", /capital letters/],
			[".hidden", /cannot start with a period/],
		] as const) {
			withPackage((pkg) => {
				pkg.name = name;
			});
			fails(dir, "CANDIDATE_BUILD_FAILED", text);
		}
		for (const version of [
			"1.0.0-01",
			"1.0.0-alpha..1",
			"v1.0.0",
			"1.0.0+build",
			" 1.0.0",
			"01.0.0",
			"1.0",
			"^1.0.0",
		]) {
			withPackage((pkg) => {
				pkg.version = version;
			});
			fails(dir, "CANDIDATE_BUILD_FAILED", /version is not an exact semver/);
		}
		// A dependency name or version under the same rules.
		withPackage((pkg) => {
			(pkg.dependencies as Record<string, string>)["a~b"] = "1.0.0";
		});
		fails(dir, "CANDIDATE_BUILD_FAILED", /dependency name a~b name can no longer contain special characters/);
		withPackage((pkg) => {
			(pkg.dependencies as Record<string, string>).react = "19.3.0-01";
		});
		fails(dir, "CANDIDATE_BUILD_FAILED", /dependency react must pin an exact version/);
		// Valid: the scoped name and exact prerelease version pass the name and version rules
		// (the prerelease then fails only on the lockfile, which locks 1.0.0).
		withPackage((pkg) => {
			pkg.name = "@anvilkit/hero-fixed";
			pkg.version = "1.0.0-alpha.1";
		});
		expect(readSource(dir, opts).packageVersion).toBe("1.0.0-alpha.1");
		writeFileSync(pkgPath, JSON.stringify(original));
		expect(readSource(dir, opts).packageName).toBe("@anvilkit/hero-fixed");
	});

	it("rejects candidate build configuration and lifecycle scripts", () => {
		const dir = copy();
		writeFileSync(path.join(dir, "rollup.config.mjs"), "export default { external: [] };\n");
		fails(dir, "CANDIDATE_BUILD_FAILED", /rollup.config.mjs: candidate build configuration is not accepted/);
		rmSync(path.join(dir, "rollup.config.mjs"));
		const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
		pkg.scripts = { postinstall: "node -e 1" };
		writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
		fails(dir, "CANDIDATE_BUILD_FAILED", /field scripts is not accepted/);
	});
	it("rejects node_modules and files outside the reviewed layout", () => {
		const dir = copy();
		mkdirSync(path.join(dir, "node_modules"));
		writeFileSync(path.join(dir, "node_modules", "x.js"), "");
		fails(dir, "CANDIDATE_BUILD_FAILED", /node_modules\/: not part of a complete source/);
		rmSync(path.join(dir, "node_modules"), { recursive: true });
		writeFileSync(path.join(dir, "src", "notes.md"), "# x\n");
		fails(dir, "CANDIDATE_BUILD_FAILED", /src\/notes.md: only .ts\/.tsx code/);
	});
	it("rejects an oversize source", () => {
		const dir = copy();
		writeFileSync(path.join(dir, "assets", "big.png"), Buffer.alloc(profiles.validator.limits.maxSourceFileBytes + 1));
		fails(dir, "CANDIDATE_BUILD_FAILED", /exceeds the file bound/);
	});
});
