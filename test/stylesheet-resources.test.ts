import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type BuildOutput, buildComponent } from "../src/build.js";
import type { BrowserObservation, BrowserWorkerResult } from "../src/host-browser-worker.js";
import { callerIdentity } from "../src/isolation.js";
import { loadProfiles, verifyToolchain } from "../src/profiles.js";
import { readSource, type SourceRead } from "../src/source.js";
import { type Certification, certify } from "../src/validate.js";
import { heroSource, mutatedBuild, removeTree, scratchCopy } from "./helpers.js";

// Delivery D-2, option (b): the preview frame and the Studio's release loader
// install each stylesheet from its verified bytes as a blob URL, and no
// artifact class carries a stylesheet's resource to them, so a relative
// reference resolves nowhere. Until a verified resource class is bound into
// the release subject, published and loaded end to end, the certification
// refuses a stylesheet that references a shipped file. What stays supported:
// a stylesheet without references, an @import of another declared stylesheet
// (the loaders install every declared stylesheet), and a declared resource
// shipped byte for byte in the npm package.

const profiles = loadProfiles();
const toolchain = verifyToolchain(profiles);
const identity = callerIdentity();
const opts = { sourceRevision: "1", profile: profiles.build, limits: profiles.validator.limits };
const scratch: string[] = [];
function work(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "anvilkit-stylesheet-resources-"));
	scratch.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of scratch) removeTree(d);
});

interface Run {
	source: SourceRead;
	build: BuildOutput;
	cert: Certification;
}

/** Reads, builds and certifies a copy of the hero after edit changed its source. */
async function certifyEdited(edit: (dir: string) => void, hostChecks = { ssr: true, browser: true }): Promise<Run> {
	const copy = scratchCopy(heroSource);
	try {
		edit(copy.dir);
		const source = readSource(copy.dir, opts);
		const build = await buildComponent(source, profiles, work(), { identity });
		const cert = await certify({ source, build, profiles, toolchain, identity, hostChecks });
		return { source, build, cert };
	} finally {
		copy.dispose();
	}
}

const appendCss = (css: string) => (dir: string) => {
	const file = path.join(dir, "styles", "hero.css");
	writeFileSync(file, `${readFileSync(file, "utf8")}${css}\n`);
};

const cssCheck = (cert: Certification) => cert.checks.find((c) => c.name === "css-resources");

describe("stylesheet resources at certification (delivery D-2)", () => {
	// Each form names assets/mark.svg, which the hero declares and ships: the
	// reference passes the static review (relative, inside the package,
	// shipped) and is refused because no loader resolves it.
	const forms: Array<[string, string]> = [
		["a plain url()", '.ak-hero__mark { background-image: url("../assets/mark.svg"); }'],
		[
			"an unquoted url() with a query and a fragment",
			".ak-hero__mark { background-image: url(../assets/mark.svg?v=1#m); }",
		],
		["an @font-face src", '@font-face { font-family: "Mark"; src: url("../assets/mark.svg") format("svg"); }'],
		["a string entry of image-set()", '.ak-hero__mark { background-image: image-set("../assets/mark.svg" 1x); }'],
		["a url() entry of image-set()", '.ak-hero__mark { background-image: image-set(url("../assets/mark.svg") 1x); }'],
		["a custom property", '.ak-hero { --mark: url("../assets/mark.svg"); }'],
		["a var() fallback", '.ak-hero__mark { background-image: var(--mark, url("../assets/mark.svg")); }'],
		["an escaped url() name", '.ak-hero__mark { background-image: u\\72l("../assets/mark.svg"); }'],
		["an escaped src() name", '.ak-hero__mark { background-image: \\73 rc("../assets/mark.svg"); }'],
		["an escaped image-set() name", '.ak-hero__mark { background-image: image\\2d set("../assets/mark.svg" 1x); }'],
	];
	for (const [name, css] of forms) {
		it(`refuses a shipped relative resource referenced through ${name}`, async () => {
			const { cert } = await certifyEdited(appendCss(css));
			expect(cert.verdict).toBe("repairable");
			expect(cert.failureCode).toBe("MISSING_CSS");
			expect(cssCheck(cert)?.status).toBe("fail");
			expect(cssCheck(cert)?.failureCode).toBe("MISSING_CSS");
			expect(cssCheck(cert)?.detail).toContain("styles/hero.css references assets/mark.svg");
			expect(cssCheck(cert)?.detail).toContain("load no stylesheet resource");
			expect(cssCheck(cert)?.detail).toContain("inline <svg>");
			// A static refusal: no candidate content ran.
			expect(cert.steps.ssr).toBeUndefined();
			expect(cert.steps.browser).toBeUndefined();
			expect(cert.checks.find((c) => c.name === "browser-host")?.status).toBe("not_run");
		});
	}

	it("names every referenced file of the refused stylesheet once", async () => {
		const { cert } = await certifyEdited((dir) => {
			writeFileSync(path.join(dir, "assets", "second.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
			const decl = JSON.parse(readFileSync(path.join(dir, "component.json"), "utf8"));
			decl.resources.push("assets/second.svg");
			writeFileSync(path.join(dir, "component.json"), `${JSON.stringify(decl, null, 2)}\n`);
			appendCss(
				'.ak-hero__mark { background-image: url("../assets/second.svg"), url("../assets/mark.svg"), url(../assets/mark.svg); }',
			)(dir);
		});
		expect(cert.failureCode).toBe("MISSING_CSS");
		expect(cssCheck(cert)?.detail).toContain("styles/hero.css references assets/mark.svg, assets/second.svg;");
	});

	it("keeps the review's own refusal for a reference that is not a shipped relative file", async () => {
		const cases: Array<[string, RegExp]> = [
			['.ak-hero__mark { background-image: url("../assets/missing.svg"); }', /which the package does not ship/],
			['.ak-hero__mark { background-image: url("https://cdn.example/mark.svg"); }', /only shipped relative resources/],
			['.ak-hero__mark { background-image: url("data:image/svg+xml,%3Csvg%3E"); }', /only shipped relative resources/],
			[".ak-hero__mark { background-image: url(../../../escape.svg); }", /escapes the package/],
		];
		for (const [css, expected] of cases) {
			const { cert } = await certifyEdited(appendCss(css), { ssr: false, browser: false });
			expect(cert.failureCode, css).toBe("MISSING_CSS");
			expect(cssCheck(cert)?.detail, css).toMatch(expected);
			expect(cssCheck(cert)?.detail, css).not.toContain("load no stylesheet resource");
		}
	});

	it("certifies the hero, whose stylesheet references no file, and still ships and inventories its declared resource", async () => {
		const { source, build, cert } = await certifyEdited(() => {});
		expect(cert.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}:${c.status}:${c.detail}`)).toEqual([]);
		expect(cert.verdict).toBe("certified");
		expect(readFileSync(path.join(heroSource, "styles", "hero.css"), "utf8")).not.toMatch(/url\(|src\(|image-set\(/i);
		// The declared resource: in the source manifest, in the tarball and in
		// the certification's bindings, byte for byte.
		const declared = source.manifest.files.find((f) => f.path === "assets/mark.svg");
		expect(declared).toBeDefined();
		expect(cert.bindings.resources).toEqual([
			{ path: "assets/mark.svg", digest: declared?.digest, sizeBytes: build.resources[0]?.sizeBytes },
		]);
		expect(cert.npmEntries.find((e) => e.path === "dist/assets/mark.svg")?.digest).toBe(declared?.digest);
		// The browser saw one stylesheet without a resource and requested none.
		const browser = cert.host.browser as BrowserWorkerResult;
		const observed = browser.observed as BrowserObservation;
		expect(observed.stylesheets).toHaveLength(1);
		expect(observed.stylesheets[0]?.resources).toEqual([]);
		expect(observed.stylesheets[0]?.effectiveRules).toBeGreaterThan(0);
		expect(browser.pageRequests.some((r) => new URL(r.url).pathname.startsWith("/candidate/dist/assets/"))).toBe(false);
	});

	it("still refuses a package that does not ship a declared resource as in the source", async () => {
		const source = readSource(heroSource, opts);
		const build = await buildComponent(source, profiles, work(), { identity });
		const hostChecks = { ssr: false, browser: false };
		const removed = await mutatedBuild(build, work(), (pkg) =>
			unlinkSync(path.join(pkg, "dist", "assets", "mark.svg")),
		);
		let cert = await certify({ source, build: removed, profiles, toolchain, identity, hostChecks });
		expect(cert.failureCode).toBe("MISSING_CSS");
		expect(cssCheck(cert)?.detail).toBe("resource assets/mark.svg is not shipped as in the source");
		const altered = await mutatedBuild(build, work(), (pkg) =>
			writeFileSync(path.join(pkg, "dist", "assets", "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>\n'),
		);
		cert = await certify({ source, build: altered, profiles, toolchain, identity, hostChecks });
		expect(cert.failureCode).toBe("MISSING_CSS");
		expect(cssCheck(cert)?.detail).toBe("resource assets/mark.svg is not shipped as in the source");
	});

	it("still accepts an @import of another declared stylesheet", async () => {
		const { cert } = await certifyEdited((dir) => {
			writeFileSync(path.join(dir, "styles", "base.css"), ".ak-hero {\n\tmargin: 4px;\n}\n");
			const decl = JSON.parse(readFileSync(path.join(dir, "component.json"), "utf8"));
			decl.styles.push("styles/base.css");
			writeFileSync(path.join(dir, "component.json"), `${JSON.stringify(decl, null, 2)}\n`);
			const hero = path.join(dir, "styles", "hero.css");
			writeFileSync(hero, `@import "base.css";\n${readFileSync(hero, "utf8")}`);
		});
		expect(cssCheck(cert)?.status).toBe("pass");
		expect(cert.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}:${c.status}:${c.detail}`)).toEqual([]);
		expect(cert.verdict).toBe("certified");
		expect(cert.bindings.css.map((c) => c.path)).toEqual(["styles/hero.css", "styles/base.css"]);
	});
});
