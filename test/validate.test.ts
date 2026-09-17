import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import commonjsPlugin from "@rollup/plugin-commonjs";
import nodeResolvePlugin from "@rollup/plugin-node-resolve";
import replacePlugin from "@rollup/plugin-replace";
import { rollup } from "rollup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BuildOutput, buildComponent } from "../src/build.js";
import { canonicalDigest } from "../src/digest.js";
import type { BrowserObservation, BrowserWorkerResult } from "../src/host-browser-worker.js";
import { callerIdentity } from "../src/isolation.js";
import { loadProfiles, type Profiles, profileDigest, verifyToolchain } from "../src/profiles.js";
import { readSource, type SourceRead } from "../src/source.js";
import { writeTarball } from "../src/tarball.js";
import { type Certification, certificationBinds, certify, stylesheetReferences, verdictFor } from "../src/validate.js";
import { heroSource, packageRoot, scratchCopy } from "./helpers.js";

type Callable<T> = T extends (...a: infer A) => infer R
	? (...a: A) => R
	: T extends { default: infer D }
		? Callable<D>
		: never;
const callable = <T>(m: T) => (typeof m === "function" ? m : (m as { default: unknown }).default) as Callable<T>;

const profiles = loadProfiles();
const toolchain = verifyToolchain(profiles);
const identity = callerIdentity();
const opts = { sourceRevision: "1", profile: profiles.build, limits: profiles.validator.limits };
const scratch: string[] = [];
function work(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "anvilkit-validate-"));
	scratch.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

let source: SourceRead;
let build: BuildOutput;
beforeAll(async () => {
	source = readSource(heroSource, opts);
	build = await buildComponent(source, profiles, work(), { identity });
});

/** A copy of the build whose staged package may be mutated and repacked. */
async function mutated(mutate: (packageDir: string) => void): Promise<BuildOutput> {
	const dir = work();
	cpSync(build.workDir, dir, { recursive: true, verbatimSymlinks: true });
	const packageDir = path.join(dir, "stage", "package");
	mutate(packageDir);
	const files: string[] = [];
	const walk = (d: string, rel = "") => {
		for (const e of require("node:fs").readdirSync(d, { withFileTypes: true })) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(d, e.name), p);
			else files.push(p);
		}
	};
	walk(packageDir);
	const tarball = path.join(dir, path.basename(build.npm.file));
	await writeTarball(path.join(dir, "stage"), files, tarball);
	return {
		...build,
		workDir: dir,
		packageDir,
		npm: { ...build.npm, file: tarball },
		browser: { ...build.browser, file: path.join(packageDir, "dist", "index.js") },
	};
}

function fails(cert: Certification, code: string, verdict: string, check: string): void {
	expect(cert.failureCode).toBe(code);
	expect(cert.verdict).toBe(verdict);
	expect(cert.checks.find((c) => c.name === check)?.status).toBe("fail");
	expect(cert.checks.find((c) => c.name === check)?.failureCode).toBe(code);
}

function withProfiles(edit: (p: Profiles) => void): Profiles {
	const p = structuredClone(profiles);
	edit(p);
	for (const doc of [p.build, p.host, p.validator])
		(doc as { profileDigest: string }).profileDigest = profileDigest(doc as unknown as Record<string, unknown>);
	return p;
}

describe("independent certification of the fixed component", () => {
	it("certifies the valid fixed component with bindings to the actual digests", async () => {
		const cert = await certify({
			source,
			build,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: true },
		});
		expect(cert.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}:${c.status}:${c.detail}`)).toEqual([]);
		expect(cert.verdict).toBe("certified");
		expect(cert.failureCode).toBeUndefined();
		expect(cert.complete).toBe(true);
		expect(cert.mandatoryChecks).toEqual(profiles.validator.checks);
		expect(cert.checks.map((c) => c.name)).toEqual([...profiles.validator.checks, "protected-fixtures-after"]);
		expect(cert.bindings.sourceDigest).toBe(source.manifest.manifestDigest);
		expect(cert.bindings.npm.digest).toBe(build.npm.digest);
		expect(cert.bindings.browser.digest).toBe(build.browser.digest);
		expect(cert.bindings.css.map((c) => c.digest)).toEqual(build.css.map((c) => c.digest));
		expect(cert.bindings.hostAbiDigest).toBe(profiles.host.profileDigest);
		expect(cert.bindings.protectedFixtures).toEqual(profiles.validator.protectedFixtures);
		expect(cert.browser.imports).toEqual(["react", "react/jsx-runtime"]);
		expect(cert.browser.exports).toEqual(["Hero", "config", "default"]);
		expect(cert.host.status).toBe("DEVELOPMENT_ONLY");
		const ssr = cert.host.ssr as { ok: boolean; reactVersion: string; fields: string[] };
		expect(ssr.ok).toBe(true);
		expect(ssr.reactVersion).toBe("19.3.0");
		expect(ssr.fields).toEqual(["align", "ctaLabel", "subtitle", "title"]);
		// The browser evidence is the worker's observation through Playwright
		// (isolated world, request log, real input, the captured control); the
		// page's own report is carried as data beside it.
		const browser = cert.host.browser as BrowserWorkerResult;
		const observed = browser.observed as BrowserObservation;
		expect(observed.elementCount).toBeGreaterThan(0);
		expect(observed.textPresent).toEqual({
			"Build once, certify exactly": true,
			"A reviewed fixed component: complete source, protected build, independent verdict.": true,
			"Get started": true,
		});
		expect(observed.undeclaredStylesheets).toEqual([]);
		expect(observed.stylesheets).toHaveLength(1);
		expect(observed.stylesheets[0]?.href).toBe("/candidate/dist/styles/hero.css");
		expect(observed.stylesheets[0]?.sameAsShipped).toBe(true);
		expect(observed.stylesheets[0]?.matchedRules).toBeGreaterThan(0);
		expect(observed.stylesheets[0]?.resources).toEqual([{ url: "/candidate/dist/assets/mark.svg", loaded: true }]);
		expect(observed.nonce).toEqual({ field: "title", rendered: true });
		expect(observed.interaction).toEqual({ buttons: 1, clicked: true, changed: true });
		expect(observed.pageErrors).toEqual([]);
		const scripts = browser.pageRequests.filter((r) => r.resourceType === "script").map((r) => new URL(r.url).pathname);
		expect(scripts.filter((p) => !p.startsWith("/host/"))).toEqual(["/candidate/dist/index.js"]);
		expect(browser.pageRequests.some((r) => new URL(r.url).pathname === "/candidate/dist/assets/mark.svg")).toBe(true);
		const page = browser.page as { renderers: string[]; resolved: Record<string, string> };
		expect(page.renderers).toHaveLength(1);
		expect(page.resolved.react).toBe("/host/react.js");
		expect(cert.steps.ssr?.code).toBe(0);
		expect(cert.steps.ssr?.stop).toEqual({ reason: "exited", confirmed: true, signaled: expect.any(Number) });
		expect(cert.steps.browser?.code).toBe(0);
		expect(cert.steps.browser?.stop.confirmed).toBe(true);
		expect(cert.steps.build.stop.confirmed).toBe(true);
		expect(cert.evidenceDigest).toBe(canonicalDigest({ ...cert, evidenceDigest: undefined }));
		// Reuse holds for the same bindings and fails for any changed one.
		const current = {
			sourceDigest: cert.bindings.sourceDigest,
			buildProfileDigest: profiles.build.profileDigest,
			validatorProfileDigest: profiles.validator.profileDigest,
			hostAbiDigest: profiles.host.profileDigest,
			npm: cert.bindings.npm,
			browser: cert.bindings.browser,
			css: cert.bindings.css,
			mandatoryChecks: profiles.validator.checks,
		};
		expect(certificationBinds(cert, current)).toBe(true);
		// A certification whose run did not pass a check the current profile mandates is not reusable.
		expect(certificationBinds(cert, { ...current, mandatoryChecks: [...current.mandatoryChecks, "studio-host"] })).toBe(
			false,
		);
		expect(certificationBinds({ ...cert, complete: false }, current)).toBe(false);
		expect(
			certificationBinds(cert, {
				...current,
				sourceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
			}),
		).toBe(false);
		expect(
			certificationBinds(cert, {
				...current,
				hostAbiDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
			}),
		).toBe(false);
		expect(certificationBinds(cert, { ...current, npm: { ...current.npm, sizeBytes: "1" } })).toBe(false);
		expect(
			certificationBinds(
				{
					...cert,
					verdict: "certified",
					bindings: {
						...cert.bindings,
						sourceDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
					},
				},
				current,
			),
		).toBe(false);
	});

	it("rejects wrong exports", async () => {
		const b = await mutated((pkg) => {
			const f = path.join(pkg, "dist", "index.js");
			writeFileSync(
				f,
				readFileSync(f, "utf8").replace("export { Hero, config, config as default };", "export { Hero, config };"),
			);
		});
		const cert = await certify({
			source,
			build: b,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: true },
		});
		fails(cert, "INVALID_EXPORTS", "repairable", "browser-module");
		expect(cert.checks.find((c) => c.name === "ssr-render")?.status).toBe("not_run");
		expect(cert.checks.find((c) => c.name === "browser-host")?.status).toBe("not_run");
	});

	it("rejects missing CSS and an unshipped resource", async () => {
		const b = await mutated((pkg) => unlinkSync(path.join(pkg, "dist", "styles", "hero.css")));
		fails(
			await certify({ source, build: b, profiles, toolchain, identity, hostChecks: { ssr: false, browser: false } }),
			"MISSING_CSS",
			"repairable",
			"css-resources",
		);
		const c = await mutated((pkg) => unlinkSync(path.join(pkg, "dist", "assets", "mark.svg")));
		fails(
			await certify({ source, build: c, profiles, toolchain, identity, hostChecks: { ssr: false, browser: false } }),
			"MISSING_CSS",
			"repairable",
			"css-resources",
		);
	});

	it("rejects a module that bundles its own React (duplicate runtime)", async () => {
		// The same component built with React inlined, as a candidate build
		// configuration would do: it imports nothing from the host.
		const inlined = work();
		const bundle = await rollup({
			input: path.join(build.workDir, "out", "index.js"),
			onwarn: () => {},
			plugins: [
				callable(replacePlugin)({
					preventAssignment: true,
					values: { "process.env.NODE_ENV": JSON.stringify("production") },
				}),
				callable(nodeResolvePlugin)({
					browser: true,
					rootDir: packageRoot,
					modulePaths: [path.join(packageRoot, "node_modules")],
				}),
				callable(commonjsPlugin)(),
			],
		});
		await bundle.write({ file: path.join(inlined, "index.js"), format: "es" });
		await bundle.close();
		const b = await mutated((pkg) => cpSync(path.join(inlined, "index.js"), path.join(pkg, "dist", "index.js")));
		const cert = await certify({
			source,
			build: b,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: true },
		});
		fails(cert, "DUPLICATE_RUNTIME", "repairable", "browser-module");
	});

	it("refuses an incompatible Host ABI as a profile problem, not a source defect", async () => {
		const p = withProfiles((x) => {
			x.host.externals.react = "18.3.1";
			x.host.externals["react-dom"] = "18.3.1";
			x.host.externals["react-dom/client"] = "18.3.1";
			x.host.externals["react/jsx-runtime"] = "18.3.1";
		});
		const cert = await certify({
			source,
			build,
			profiles: p,
			toolchain,
			identity,
			hostChecks: { ssr: false, browser: false },
		});
		fails(cert, "PROFILE_UNQUALIFIED", "infrastructure_failed", "npm-package");
	});

	it("refuses altered protected fixtures without executing them", async () => {
		const root = work();
		mkdirSync(path.join(root, "fixtures"), { recursive: true });
		cpSync(path.join(packageRoot, "fixtures", "host"), path.join(root, "fixtures", "host"), { recursive: true });
		const ssr = path.join(root, "fixtures", "host", "ssr.mjs");
		writeFileSync(ssr, `${readFileSync(ssr, "utf8")}\n// altered\n`);
		const cert = await certify({
			source,
			build,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: false },
			fixturesRoot: root,
		});
		fails(cert, "PROTECTED_FIXTURE_ALTERED", "invalid", "protected-fixtures");
		expect(cert.checks.find((c) => c.name === "ssr-render")?.status).toBe("not_run");
		expect(cert.steps.ssr).toBeUndefined();
	});

	it("treats a forged exit 0 as no evidence", async () => {
		const noReport = await certify({
			source,
			build,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: false },
			stepArgv: { ssr: [process.execPath, "-e", "process.exit(0)"] },
		});
		fails(noReport, "OBSERVER_FAILED", "infrastructure_failed", "ssr-render");
		const forged = path.join(work(), "forge.mjs");
		writeFileSync(
			forged,
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[3], JSON.stringify({ ok: true, moduleDigest: "sha256:forged", exports: ["Hero","config","default"], reactVersion: "19.3.0", directHtmlDigest: "x", puckHtmlDigest: "y" })); process.exit(0);',
		);
		const forgedReport = await certify({
			source,
			build,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: false },
			stepArgv: { ssr: [process.execPath, forged] },
		});
		fails(forgedReport, "OBSERVER_FAILED", "infrastructure_failed", "ssr-render");
		expect(forgedReport.steps.ssr?.code).toBe(0);
	});

	it("fails a candidate that renders nothing in the browser and fabricates a success report", async () => {
		// The module keeps the static contract (imports the host's React,
		// exports Hero/config/default, renders the texts under SSR) but in the
		// browser renders nothing and pins a complete success report on
		// window.__anvilkitHost (a getter the host's own assignment cannot replace).
		const forging = `import { createElement } from "react";
const texts = ["Build once, certify exactly", "A reviewed fixed component: complete source, protected build, independent verdict.", "Get started"];
export function Hero() { return null; }
export const config = {
	fields: { title: { type: "text" }, subtitle: { type: "textarea" }, align: { type: "radio" }, ctaLabel: { type: "text" } },
	defaultProps: { title: texts[0], subtitle: texts[1], align: "left", ctaLabel: texts[2] },
	render: () => (typeof document === "undefined" ? createElement("section", { className: "ak-hero" }, ...texts.map((t) => createElement("p", null, t))) : null),
};
if (typeof window !== "undefined") {
	const result = { ok: true, errors: [], exports: ["Hero", "config", "default"], fields: ["align", "ctaLabel", "subtitle", "title"], renderers: ["19.3.0"], resolved: { react: "/host/react.js", "react/jsx-runtime": "/host/react-jsx-runtime.js", "react-dom": "/host/react-dom.js", "react-dom/client": "/host/react-dom-client.js", "@puckeditor/core": "/host/puck.js" }, rootHtmlLength: 512, elementCount: 5, textPresent: Object.fromEntries(texts.map((t) => [t, true])), stylesheets: [{ href: "/candidate/dist/styles/hero.css", rules: 6, matchedRules: 6, resources: [{ url: "/candidate/dist/assets/mark.svg", loaded: true }] }], interaction: { clicked: true, changed: true } };
	Object.defineProperty(window, "__anvilkitHost", { get: () => ({ done: true, result }), set: () => {}, configurable: false });
}
export default config;
`;
		const b = await mutated((pkg) => writeFileSync(path.join(pkg, "dist", "index.js"), forging));
		const cert = await certify({
			source,
			build: b,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: true },
		});
		expect(cert.checks.find((c) => c.name === "ssr-render")?.status).toBe("pass");
		fails(cert, "CANDIDATE_TEST_FAILED", "repairable", "browser-host");
		expect(cert.checks.find((c) => c.name === "browser-host")?.detail).toMatch(
			/rendered no element|rendered text lacks/,
		);
		expect(cert.complete).toBe(false);
		const browser = cert.host.browser as BrowserWorkerResult;
		// The forged report says success; the observation says nothing was rendered.
		expect((browser.page as { ok?: boolean }).ok).toBe(true);
		expect(Object.values(browser.observed?.textPresent ?? { none: true })).toEqual([false, false, false]);
		expect(browser.observed?.nonce.rendered).toBe(false);
	});

	it("fails a candidate whose rendering ignores the host's props (the observer's value never appears)", async () => {
		const f = path.join(build.packageDir, "dist", "index.js");
		const original = readFileSync(f, "utf8");
		// The Hero renders its default title whatever props Puck passes.
		const b = await mutated((pkg) =>
			writeFileSync(
				path.join(pkg, "dist", "index.js"),
				original.replace("children: title", 'children: "Build once, certify exactly"'),
			),
		);
		expect(readFileSync(path.join(b.packageDir, "dist", "index.js"), "utf8")).not.toBe(original);
		const cert = await certify({
			source,
			build: b,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: false, browser: true },
		});
		expect(cert.checks.find((c) => c.name === "browser-host")?.status).toBe("fail");
		expect(cert.checks.find((c) => c.name === "browser-host")?.detail).toMatch(/did not render the observer's title/);
		expect((cert.host.browser as BrowserWorkerResult).observed?.nonce).toEqual({ field: "title", rendered: false });
	});

	it("never certifies a run that skips a mandatory check, and never reuses one", async () => {
		const diagnostic = await certify({
			source,
			build,
			profiles,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: false },
		});
		expect(diagnostic.checks.find((c) => c.name === "browser-host")?.status).toBe("not_run");
		expect(diagnostic.checks.filter((c) => c.status === "fail")).toEqual([]);
		expect(diagnostic.complete).toBe(false);
		expect(diagnostic.verdict).toBe("infrastructure_failed");
		expect(diagnostic.failureCode).toBe("OBSERVER_FAILED");
		const current = {
			sourceDigest: diagnostic.bindings.sourceDigest,
			buildProfileDigest: profiles.build.profileDigest,
			validatorProfileDigest: profiles.validator.profileDigest,
			hostAbiDigest: profiles.host.profileDigest,
			npm: diagnostic.bindings.npm,
			browser: diagnostic.bindings.browser,
			css: diagnostic.bindings.css,
		};
		expect(certificationBinds(diagnostic, current)).toBe(false);
		// A forged "certified" over the same document is refused by the evidence digest and the completeness rule.
		expect(
			certificationBinds({ ...diagnostic, verdict: "certified", complete: true, failureCode: undefined }, current),
		).toBe(false);
		// The rule follows the reviewed profile: a profile that does not mandate
		// the browser host lets the same run complete (this is not the
		// development profile, whose checks stay as reviewed).
		const p = withProfiles((x) => {
			x.validator.checks = x.validator.checks.filter((c) => c !== "browser-host");
		});
		const complete = await certify({
			source,
			build,
			profiles: p,
			toolchain,
			identity,
			hostChecks: { ssr: true, browser: false },
		});
		expect(complete.complete).toBe(true);
		expect(complete.verdict).toBe("certified");
	});

	it("reviews stylesheet references with a CSS parser before any browser runs", async () => {
		const shipped = new Set([
			"dist/styles/hero.css",
			"dist/styles/base.css",
			"dist/assets/mark.svg",
			"dist/assets/a b.svg",
		]);
		const refs = (text: string) =>
			stylesheetReferences(
				"styles/hero.css",
				text,
				(p) => shipped.has(p),
				(m) => {
					throw new Error(m);
				},
			);
		expect(
			refs(
				'@import "base.css"; .a { background: url(../assets/mark.svg#x?y); } .b::before { content: url("../assets/a%20b.svg"); }',
			),
		).toEqual({
			imports: ["dist/styles/base.css"],
			resources: ["dist/assets/a b.svg", "dist/assets/mark.svg"],
			selectors: [".a", ".b::before"],
		});
		const refused: Array<[string, RegExp]> = [
			[
				'@import "https://cdn.example/reset.css";',
				/references https:\/\/cdn.example\/reset.css; only shipped relative/,
			],
			["@import url(//cdn.example/reset.css);", /only shipped relative resources/],
			['@import "reset.css";', /references reset.css, which the package does not ship/],
			['@import url("../assets/mark.svg");', /imports ..\/assets\/mark.svg, which is not a shipped stylesheet/],
			[".x { background: url(/etc/hostname); }", /absolute path \/etc\/hostname/],
			[".x { background: url(../../../escape.svg); }", /escapes the package/],
			[".x { background: url(../assets/missing.svg); }", /which the package does not ship/],
			['.x { background: url("data:image/svg+xml,%3Csvg%3E"); }', /only shipped relative resources/],
			['.x { background: url("javascript:alert(1)"); }', /only shipped relative resources/],
			[".x { background: url(../assets/%ZZ.svg); }", /does not percent-decode/],
			[".x { color: red; } }", /does not parse as CSS/],
			['@font-face { src: url(../assets/font.woff2) format("woff2"); }', /which the package does not ship/],
			['.x { background: image-set(url("../assets/none.png") 1x); }', /which the package does not ship/],
		];
		for (const [text, expected] of refused) expect(() => refs(text), text).toThrow(expected);
		// End to end: a remote @import in the source fails the static check; no host runs.
		const dir = scratchCopy(heroSource);
		try {
			const css = path.join(dir.dir, "styles", "hero.css");
			writeFileSync(css, `@import url("https://cdn.example/reset.css");\n${readFileSync(css, "utf8")}`);
			const src = readSource(dir.dir, opts);
			const b = await buildComponent(src, profiles, work(), { identity });
			const cert = await certify({
				source: src,
				build: b,
				profiles,
				toolchain,
				identity,
				hostChecks: { ssr: true, browser: true },
			});
			fails(cert, "MISSING_CSS", "repairable", "css-resources");
			expect(cert.checks.find((c) => c.name === "css-resources")?.detail).toMatch(/only shipped relative resources/);
			expect(cert.steps.ssr).toBeUndefined();
			expect(cert.steps.browser).toBeUndefined();
		} finally {
			dir.dispose();
		}
	});

	it("maps failure codes to verdicts so that infrastructure failures are never repair targets", () => {
		expect(verdictFor(profiles, "PATH_ESCAPE")).toBe("invalid");
		expect(verdictFor(profiles, "OBSERVER_FAILED")).toBe("infrastructure_failed");
		expect(verdictFor(profiles, "PROFILE_UNQUALIFIED")).toBe("infrastructure_failed");
		expect(verdictFor(profiles, "CANDIDATE_BUILD_FAILED")).toBe("repairable");
		expect(verdictFor(profiles, "CANCELED")).toBe("canceled");
	});
});
