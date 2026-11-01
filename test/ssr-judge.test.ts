import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { packageRoot, removeTree } from "./helpers.js";

const ssrScript = path.join(packageRoot, "fixtures", "host", "ssr.mjs");

type Verdict = { ok: boolean; errors: string[] };

/** Runs the SSR harness step (`ssr.mjs --judge`) on a frame, as the validator does: inputs on stdin, verdict on fd 3. */
function judge(io: Record<string, unknown>): Promise<Verdict> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [ssrScript, "--judge"], { stdio: ["pipe", "ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdio[3]?.on("data", (b: Buffer) => out.push(b));
		child.stderr?.on("data", (b: Buffer) => err.push(b));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(`judge exited ${code}: ${Buffer.concat(err).toString("utf8")}`));
			resolve(JSON.parse(Buffer.concat(out).toString("utf8")) as Verdict);
		});
		child.stdin?.end(JSON.stringify(io));
	});
}

describe("the SSR judge's default-text match (B1 run 5, C1)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) removeTree(d);
	});

	function inputs(directText: string, expected: string) {
		const dir = mkdtempSync(path.join(tmpdir(), "anvilkit-ssr-judge-"));
		dirs.push(dir);
		const modulePath = path.join(dir, "module.js");
		const bytes = Buffer.from("export default {};\n");
		writeFileSync(modulePath, bytes);
		const nonce = "anvilkit-0123456789abcdef";
		// The render child's frame, from react-dom/server itself: the HTML the judge sees.
		const direct = renderToString(createElement("p", null, createElement("span", null, directText)));
		const puck = renderToString(createElement("div", null, createElement("span", null, nonce)));
		return {
			modulePath,
			moduleDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			fieldNames: ["text"],
			expectedTexts: [expected],
			puckExpectedTexts: [],
			nonce,
			frame: JSON.stringify({ schemaVersion: 1, meta: { fields: ["text"], reactVersion: "19.3.0" }, direct, puck }),
			renderExit: "exit 0, signal null",
		};
	}

	it("finds a default with HTML-escaped characters in the rendered HTML", async () => {
		const text = `We'll be performing scheduled maintenance on Sunday from 02:00 to 04:00 UTC & "soon" <today>.`;
		const io = inputs(text, text);
		// react-dom/server writes the apostrophe as &#x27; (the run-5 false negative).
		expect(JSON.parse(io.frame as string).direct).toContain("We&#x27;ll");
		const verdict = await judge(io);
		expect(verdict.errors).toEqual([]);
		expect(verdict.ok).toBe(true);
	});

	it("still refuses a render that lacks the default text", async () => {
		const verdict = await judge(inputs("Something else", "We'll be back soon."));
		expect(verdict.ok).toBe(false);
		expect(verdict.errors).toEqual([`rendered HTML lacks the default text "We'll be back soon."`]);
	});
});

describe("the SSR judge's field sinks (the field-sinks check; B1 run 10's security review)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) removeTree(d);
	});
	const marker = "anvilkit-probe-0123456789abcdef";
	const values = [`javascript:alert(1)//${marker}`, ` Data:text/html,${marker}`];

	/** A frame whose two renders pass and whose probe renders are the given HTML (or a render error). */
	function inputs(probes: Array<{ html: string } | { error: string }>, probe: unknown = { marker, values }) {
		const dir = mkdtempSync(path.join(tmpdir(), "anvilkit-ssr-sinks-"));
		dirs.push(dir);
		const modulePath = path.join(dir, "module.js");
		const bytes = Buffer.from("export default {};\n");
		writeFileSync(modulePath, bytes);
		const nonce = "anvilkit-0123456789abcdef";
		const direct = renderToString(createElement("p", null, "Shown"));
		const puck = renderToString(createElement("p", null, nonce));
		return {
			modulePath,
			moduleDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			fieldNames: ["text"],
			expectedTexts: ["Shown"],
			puckExpectedTexts: [],
			nonce,
			probe,
			frame: JSON.stringify({
				schemaVersion: 1,
				meta: { fields: ["text"], reactVersion: "19.3.0" },
				direct,
				puck,
				probes,
			}),
			renderExit: "exit 0, signal null",
		};
	}
	const link = (href: string) => ({ html: renderToString(createElement("a", { href }, "go")) });
	const sinks = async (io: Record<string, unknown>) =>
		((await judge(io)) as Verdict & { sinks?: { ok: boolean; probes: number; errors: string[] } }).sinks;

	it("passes probe renders whose links keep a safe scheme and whose styles never carry the value", async () => {
		const styled = { html: renderToString(createElement("div", { style: { color: "#0b3d91" } }, "x")) };
		expect(await sinks(inputs([link("/start"), styled]))).toEqual({ ok: true, probes: 2, errors: [] });
	});

	it("refuses React's blocked javascript: URL and a data: URL in an href", async () => {
		const result = await sinks(inputs([link(values[0] ?? ""), link(values[1] ?? "")]));
		expect(result?.ok).toBe(false);
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[0])}, <a href> renders a javascript: URL; a text value reaches a URL attribute only after a scheme check that keeps relative, http:, https:, mailto: and tel: URLs`,
			`with every text field set to ${JSON.stringify(values[1])}, <a href> renders a data: URL; a text value reaches a URL attribute only after a scheme check that keeps relative, http:, https:, mailto: and tel: URLs`,
		]);
	});

	it("reads the scheme as a browser does: character references, case, outer spaces, tabs and srcset candidates", async () => {
		const html = `<a href="&#x6A;ava&#x09;script:x">a</a><form><button formAction=" VBScript:x">b</button></form><img srcset="/a.png 1x, data:image/png,${marker} 2x"/>`;
		const result = await sinks(inputs([{ html }, link("https://example.com/")]));
		expect(result?.errors.map((e) => e.split(";")[0]?.replace(/^.*, (<[^>]+>)/, "$1"))).toEqual([
			"<a href> renders a javascript: URL",
			"<button formaction> renders a vbscript: URL",
			"<img srcset> renders a data: URL",
		]);
	});

	it("refuses the value in an inline style or a <style> element", async () => {
		const inline = {
			html: renderToString(createElement("div", { style: { ["--accent" as string]: values[0] } }, "x")),
		};
		const element = { html: `<div><style>.x{color:${marker}}</style></div>` };
		const result = await sinks(inputs([inline, element]));
		expect(result?.ok).toBe(false);
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[0])}, the inline style of <div> carries the value; a text value reaches an inline style only after it matches a fixed pattern`,
			`with every text field set to ${JSON.stringify(values[1])}, a <style> element carries the value; a text value never reaches CSS`,
		]);
	});

	it("refuses a probe render that threw and a frame that lacks a probe the observer asked for", async () => {
		expect((await sinks(inputs([{ error: "Error: bad label" }, link("/")])))?.errors).toEqual([
			`the component threw when every text field held ${JSON.stringify(values[0])}: Error: bad label`,
		]);
		expect((await sinks(inputs([link("/")])))?.errors).toEqual([
			"the render child returned 1 probe renders, the observer asked for 2",
		]);
	});

	it("has nothing to probe without a text field, and keeps the render verdict apart from the sinks", async () => {
		const io = inputs([], { marker, values: [] });
		const verdict = await judge(io);
		expect(verdict.ok).toBe(true);
		expect(await sinks(io)).toEqual({ ok: true, probes: 0, errors: [] });
		const failing = await judge(inputs([link(values[0] ?? ""), link("/")]));
		expect(failing.ok).toBe(true);
		expect(failing.errors).toEqual([]);
	});
});
