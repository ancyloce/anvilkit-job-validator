import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOutput } from "../src/build.js";
import { writeTarball } from "../src/tarball.js";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const heroSource = path.join(packageRoot, "fixtures", "component", "hero");

/** A disposable copy of a fixture directory (world-readable, as a staged workspace is). */
export function scratchCopy(source: string, prefix = "anvilkit-validator-"): { dir: string; dispose: () => void } {
	const base = process.env.ANVILKIT_VALIDATOR_SCRATCH ?? tmpdir();
	const dir = mkdtempSync(path.join(base, prefix));
	cpSync(source, dir, { recursive: true });
	return { dir, dispose: () => removeTree(dir) };
}

/**
 * Removes a tree the build left read-only (0o555 directories, 0o444 files):
 * every directory is made writable first, which root does not need but any
 * other user does (the parent's static chain runs the suite unprivileged).
 * Symbolic links are not followed.
 */
export function removeTree(dir: string): void {
	const open = (d: string) => {
		try {
			chmodSync(d, 0o755);
		} catch {
			return;
		}
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory() && !lstatSync(p).isSymbolicLink()) open(p);
		}
	};
	if (existsSync(dir)) open(dir);
	rmSync(dir, { recursive: true, force: true });
}

/**
 * The gate of the root-only tests (real step UIDs, PID and mount
 * namespaces): why they cannot run here, or "" when they can. They are
 * skipped where they cannot run, unless ANVILKIT_REQUIRE_ROOT_TESTS=1 (the
 * CI's root step), which turns the reason into a failure.
 */
export function rootGate(tools: string[]): { skip: boolean; reason: string; assert: () => void } {
	const missing = tools.filter((t) => !existsSync(t));
	const reason =
		process.getuid?.() !== 0
			? "needs a root caller (real step UIDs)"
			: missing.length
				? `needs ${missing.join(", ")}`
				: "";
	const required = process.env.ANVILKIT_REQUIRE_ROOT_TESTS === "1";
	return {
		skip: reason !== "" && !required,
		reason,
		assert: () => {
			if (reason) throw new Error(`root-only test required (ANVILKIT_REQUIRE_ROOT_TESTS=1) but ${reason}`);
		},
	};
}

/**
 * A copy of a build (into dir, which it makes world-traversable as the
 * build's own work tree is) whose staged package is mutated and repacked:
 * the bytes the certification then reads are the mutated ones.
 */
export async function mutatedBuild(
	build: BuildOutput,
	dir: string,
	mutate: (packageDir: string) => void,
): Promise<BuildOutput> {
	cpSync(build.workDir, dir, { recursive: true, verbatimSymlinks: true });
	chmodSync(dir, 0o755);
	const packageDir = path.join(dir, "stage", "package");
	mutate(packageDir);
	const files: string[] = [];
	const walk = (d: string, rel = "") => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
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

export const heroTexts = [
	"Build once, certify exactly",
	"A reviewed fixed component: complete source, protected build, independent verdict.",
	"Get started",
];

/**
 * A module that keeps the fixed Hero's static contract (imports the host's
 * React, exports Hero/config/default) and, when imported under SSR, forges
 * evidence wherever it can reach in the work tree without a static import of a Node builtin
 * (process.getBuiltinModule): "throw" writes passing reports and HTML files
 * and lets its render throw; "frame" also writes a complete render frame to
 * its inherited descriptors and exits 0 before any render; "plant" puts a
 * FIFO and symbolic links at the report names and lets its render throw.
 */
export function forgingModule(mode: "throw" | "frame" | "plant"): string {
	const html = `<section>${heroTexts.map((t) => `<p>${t}</p>`).join("")}</section>`;
	const report = {
		ok: true,
		schemaVersion: 1,
		moduleDigest: "sha256:forged",
		exports: ["Hero", "config", "default"],
		fields: ["align", "ctaLabel", "subtitle", "title"],
		reactVersion: "19.3.0",
		directHtmlDigest: "sha256:forged",
		puckHtmlDigest: "sha256:forged",
	};
	const frame = {
		schemaVersion: 1,
		direct: html,
		puck: html,
		meta: { errors: [], exports: report.exports, fields: report.fields, reactVersion: "19.3.0" },
	};
	return `import { createElement } from "react";
if (typeof process !== "undefined" && typeof window === "undefined") {
	const fs = process.getBuiltinModule("node:fs");
	const cp = process.getBuiltinModule("node:child_process");
	const path = process.getBuiltinModule("node:path");
	const report = ${JSON.stringify(JSON.stringify(report))};
	const html = ${JSON.stringify(html)};
	const names = { "ssr-result.json": report, "ssr-direct.html": html, "ssr-puck.html": html, "ssr-meta.json": ${JSON.stringify(JSON.stringify(frame.meta))}, "browser-result.json": report };
	// Its HOME and TMPDIR and every directory beside them in the work tree
	// (never its working directory, the validator package itself, which a
	// caller-identity test run could write).
	const dirs = new Set([process.env.HOME, process.env.TMPDIR].filter(Boolean));
	for (const base of [...dirs]) {
		const parent = path.dirname(base);
		try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) dirs.add(path.join(parent, e.name)); } catch {}
	}
	for (const dir of dirs) {
		for (const [name, body] of Object.entries(names)) {
			const p = path.join(dir, name);
			try {
				${
					mode === "plant"
						? `if (name === "ssr-result.json") cp.execFileSync("mkfifo", [p]);
				else if (name === "browser-result.json") fs.symlinkSync("/dev/zero", p);
				else fs.symlinkSync(path.join(dir, "forged-target.json"), p);`
						: "fs.writeFileSync(p, body);"
				}
			} catch {}
		}
		${mode === "plant" ? 'try { fs.writeFileSync(path.join(dir, "forged-target.json"), report); } catch {}' : ""}
	}
	${
		mode === "frame"
			? `const frame = ${JSON.stringify(JSON.stringify(frame))};
	for (const fd of [1, 3]) { try { fs.writeSync(fd, frame); } catch {} }
	process.exit(0);`
			: ""
	}
}
export function Hero() {
	return null;
}
export const config = {
	fields: { title: { type: "text" }, subtitle: { type: "textarea" }, align: { type: "radio" }, ctaLabel: { type: "text" } },
	defaultProps: { title: ${JSON.stringify(heroTexts[0])}, subtitle: ${JSON.stringify(heroTexts[1])}, align: "left", ctaLabel: ${JSON.stringify(heroTexts[2])} },
	render() {
		throw new Error("candidate SSR failure");
	},
};
export default config;
`;
}

/**
 * A browser module with the hero's exports, fields and defaults that routes a
 * text field into a sink (the field-sinks check, B1 run 10's security review):
 * `href` the CTA label into a link's href, `style` the subtitle into an inline
 * custom property, `checked` both behind the checks the source contract asks
 * for (a scheme allowlist, a colour pattern), `throw` a render that throws on a
 * value with a colon.
 */
export function sinkModule(mode: "href" | "style" | "checked" | "throw"): string {
	return `import { createElement as h } from "react";
const safeHref = (v) => (/^(https?:|mailto:|tel:|\\/(?!\\/)|#)/i.test(v.trim()) ? v.trim() : "/start");
const safeColour = (v) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : "#0b3d91");
export function Hero({ title, subtitle, align, ctaLabel }) {
	${mode === "throw" ? 'if (ctaLabel.includes(":")) throw new Error("unexpected label");' : ""}
	const style = ${mode === "style" ? '{ "--ak-accent": subtitle }' : mode === "checked" ? '{ "--ak-accent": safeColour(subtitle) }' : "undefined"};
	const href = ${mode === "href" ? "ctaLabel" : mode === "checked" ? "safeHref(ctaLabel)" : '"/start"'};
	return h("section", { className: "ak-hero ak-hero--" + align, "data-anvilkit-component": "Hero", style },
		h("h1", { className: "ak-hero__title" }, title),
		h("p", { className: "ak-hero__subtitle" }, subtitle),
		h("a", { className: "ak-hero__cta", href }, ctaLabel));
}
export const config = {
	fields: { title: { type: "text" }, subtitle: { type: "textarea" }, align: { type: "radio" }, ctaLabel: { type: "text" } },
	defaultProps: { title: ${JSON.stringify(heroTexts[0])}, subtitle: ${JSON.stringify(heroTexts[1])}, align: "left", ctaLabel: ${JSON.stringify(heroTexts[2])} },
	render: (props) => h(Hero, props),
};
export default config;
`;
}

/** Every file (or link or FIFO) named like a report under the work tree: what the forging module planted. */
export function forgedFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory() && e.name !== "node_modules") walk(p);
			else if (/^(ssr-result|ssr-direct|ssr-puck|ssr-meta|browser-result)\./.test(e.name)) out.push(p);
		}
	};
	walk(root);
	return out;
}
