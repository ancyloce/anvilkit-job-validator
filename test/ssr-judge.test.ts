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

	it("names the field that owns the missing default and the remedy the observer hands over (DEC-043)", async () => {
		const remedy =
			"every non-empty text or textarea default is visible text of the component on the first render (C16)";
		const io = { ...inputs("Something else", "/terms"), defaultFields: { "/terms": "text field linkHref" }, remedy };
		const verdict = await judge(io);
		expect(verdict.errors).toEqual([
			`rendered HTML lacks the default text "/terms" of the text field linkHref; ${remedy}`,
		]);
	});
});

describe("the SSR judge's field sinks (the field-sinks check; B1 run 10's security review)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) removeTree(d);
	});
	const marker = "anvilkit-probe-0123456789abcdef";
	const values = [
		`javascript:alert(1)//${marker}`,
		` Data:text/html,${marker}`,
		`"'><${marker} ${marker}="1"></${marker}>`,
	];
	type Described = { value: string; field?: string; type?: string };
	const gateValue = ` Data:text/html,"'><${marker} ${marker}="1"></${marker}>`;
	const text = (value: string): Described => ({ value });
	const textProbes = (n: number) => values.slice(0, n).map(text);

	/** A frame whose two renders pass and whose probe renders are the given HTML (or a render error). */
	function inputs(
		probes: Array<{ html: string } | { error: string } | { limited: true }>,
		described: Described[] = textProbes(probes.length),
		probe: unknown = { marker, probes: described, gateValue },
		extra: { direct?: string; gated?: unknown[]; probeLimit?: unknown } = {},
	) {
		const dir = mkdtempSync(path.join(tmpdir(), "anvilkit-ssr-sinks-"));
		dirs.push(dir);
		const modulePath = path.join(dir, "module.js");
		const bytes = Buffer.from("export default {};\n");
		writeFileSync(modulePath, bytes);
		const nonce = "anvilkit-0123456789abcdef";
		const direct = extra.direct ?? renderToString(createElement("p", null, "Shown"));
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
				...(extra.gated ? { gated: extra.gated } : {}),
				...(extra.probeLimit ? { probeLimit: extra.probeLimit } : {}),
			}),
			renderExit: "exit 0, signal null",
		};
	}
	const link = (href: string) => ({ html: renderToString(createElement("a", { href }, "go")) });
	const sinks = async (io: Record<string, unknown>) =>
		((await judge(io)) as Verdict & { sinks?: { ok: boolean; probes: number; gated: number; errors: string[] } }).sinks;
	const urlRule =
		"a text value reaches a URL attribute only after a scheme check that keeps relative, http:, https:, mailto: and tel: URLs";

	it("passes probe renders whose links keep a safe scheme, whose styles never carry the value and whose markup is escaped", async () => {
		const styled = { html: renderToString(createElement("div", { style: { color: "#0b3d91" } }, "x")) };
		// React escapes the markup probe in text and attributes alike.
		const escaped = {
			html: renderToString(createElement("p", { title: values[2], className: `ak--${values[2]}` }, values[2])),
		};
		expect(escaped.html).toContain("&lt;anvilkit-probe-");
		expect(await sinks(inputs([link("/start"), styled, escaped]))).toEqual({
			ok: true,
			probes: 3,
			gated: 0,
			errors: [],
		});
	});

	it("refuses React's blocked javascript: URL and a data: URL in an href", async () => {
		const result = await sinks(inputs([link(values[0] ?? ""), link(values[1] ?? "")]));
		expect(result?.ok).toBe(false);
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[0])}, <a href> renders a javascript: URL; ${urlRule}`,
			`with every text field set to ${JSON.stringify(values[1])}, <a href> renders a data: URL; ${urlRule}`,
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

	it("refuses the value in an inline style, a <style> element or a <script> element", async () => {
		const inline = {
			html: renderToString(createElement("div", { style: { ["--accent" as string]: values[0] } }, "x")),
		};
		const element = { html: `<div><style>.x{color:${marker}}</style></div>` };
		const script = { html: `<div><script>window.x = "${marker}";</script></div>` };
		const result = await sinks(inputs([inline, element, script]));
		expect(result?.ok).toBe(false);
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[0])}, the inline style of <div> carries the value; a text value reaches an inline style only after it matches a fixed pattern`,
			`with every text field set to ${JSON.stringify(values[1])}, a <style> element carries the value; a field value never reaches CSS`,
			`with every text field set to ${JSON.stringify(values[2])}, a <script> element carries the value; a field value never reaches a script`,
		]);
	});

	it("refuses the value rendered as markup (dangerouslySetInnerHTML), and never reads raw text as markup", async () => {
		// What react-dom/server writes for a div whose dangerouslySetInnerHTML
		// concatenates the value into markup: the inner HTML verbatim.
		const injected = { html: `<div><p title="${values[2]}">x</p></div>` };
		expect(injected.html).toContain(`<${marker} ${marker}="1">`);
		const inStyle = { html: `<style>.x::after{content:"<${marker}>"}</style>` };
		const result = await sinks(
			inputs([link("/"), link("/"), injected, inStyle], [...textProbes(3), text(values[2] ?? "")]),
		);
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[2])}, the value is rendered as markup; a field value reaches the page only as React text or an attribute value, never through dangerouslySetInnerHTML or srcdoc`,
			`with every text field set to ${JSON.stringify(values[2])}, a <style> element carries the value; a field value never reaches CSS`,
		]);
	});

	it("names a select or radio field in its own probe, with the options rule", async () => {
		const accent = { value: values[0] ?? "", field: "accent", type: "select" };
		const target = { value: values[1] ?? "", field: "target", type: "radio" };
		const styled = { html: renderToString(createElement("div", { style: { color: values[0] } }, "x")) };
		const result = await sinks(
			inputs([styled, link(values[1] ?? ""), { error: "Error: unknown accent" }], [accent, target, accent]),
		);
		expect(result?.errors).toEqual([
			`with the select field accent set to ${JSON.stringify(values[0])}, the inline style of <div> carries the value; a select or radio value reaches an inline style only after it matches one of the field's options`,
			`with the radio field target set to ${JSON.stringify(values[1])}, <a href> renders a data: URL; a select or radio value reaches a URL attribute only after it matches one of the field's options`,
			`the component threw when the select field accent held ${JSON.stringify(values[0])}: Error: unknown accent`,
		]);
	});

	it("refuses a probe render that threw and a frame that lacks a probe the observer asked for", async () => {
		expect((await sinks(inputs([{ error: "Error: bad label" }, link("/")])))?.errors).toEqual([
			`the component threw when every text field held ${JSON.stringify(values[0])}: Error: bad label`,
		]);
		expect((await sinks(inputs([link("/")], textProbes(2))))?.errors).toEqual([
			"the render child returned 1 probe renders, the observer asked for 2",
		]);
	});

	it("carries at most eight sentences and counts the rest", async () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ value: values[0] ?? "", field: `f${i}`, type: "select" }));
		const result = await sinks(
			inputs(
				many.map(() => link(values[0] ?? "")),
				many,
			),
		);
		expect(result?.errors).toHaveLength(9);
		expect(result?.errors.at(-1)).toBe("and 2 more");
	});

	it("counts no unsafe URL the render without the value already has, nor React's function form action", async () => {
		// What react-dom/server writes for a constant href="javascript:void(0)": its blocked-URL replacement.
		const constant = `<a href="javascript:throw new Error(&#x27;React has blocked a javascript: URL as a security precaution.&#x27;)">menu</a>`;
		const direct = `<div><p>Shown</p>${constant}</div>`;
		const form = `<form action="javascript:throw new Error(&#x27;React form unexpectedly submitted.&#x27;)"><button>Send</button></form>`;
		const same = { html: `${constant}${form}` };
		const result = await sinks(inputs([same, same], textProbes(2), undefined, { direct }));
		expect(result).toEqual({ ok: true, probes: 2, gated: 0, errors: [] });
		// A second blocked javascript: link beside the constant one is a field sink again.
		const twice = { html: `${constant}${link(values[0] ?? "").html}` };
		expect((await sinks(inputs([twice], textProbes(1), undefined, { direct })))?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[0])}, <a href> renders a javascript: URL; ${urlRule}`,
		]);
	});

	it("scans the start tag of a <script> element and refuses the value inside srcdoc", async () => {
		const script = { html: `<script src="${values[1]}"></script>` };
		const frame = { html: renderToString(createElement("iframe", { srcDoc: `<p>${values[2]}</p>`, title: "t" })) };
		const result = await sinks(inputs([link("/"), script, frame], textProbes(3)));
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(values[1])}, <script src> renders a data: URL; ${urlRule}`,
			`with every text field set to ${JSON.stringify(values[2])}, the value is rendered as markup; a field value reaches the page only as React text or an attribute value, never through dangerouslySetInnerHTML or srcdoc`,
		]);
	});

	it("judges the gated renders against their own baseline and names the option they opened", async () => {
		const showCta = { value: values[0] ?? "", field: "showCta", type: "radio" };
		const gated = [
			{ field: "showCta", option: "true", baseline: { html: "<p>x</p>" }, probe: link(gateValue) },
			{ field: "showCta", option: "maybe", baseline: { error: "Error: no such option" }, probe: { html: "" } },
			{ field: "showCta", option: "later", baseline: { limited: true }, probe: { limited: true } },
		];
		const result = await sinks(inputs([link("/")], [showCta], undefined, { gated }));
		expect(result?.gated).toBe(1);
		expect(result?.errors).toEqual([
			`with every text field set to ${JSON.stringify(gateValue)} and the radio field showCta set to "true", <a href> renders a data: URL; ${urlRule}`,
			`the component threw when the radio field showCta held "maybe": Error: no such option`,
		]);
	});

	it("reports the probe byte bound once, apart from any throw, and quotes at most 400 characters of an error", async () => {
		const result = await sinks(
			inputs([{ limited: true }, { limited: true }], textProbes(2), undefined, { probeLimit: { bound: 4194304 } }),
		);
		expect(result?.errors).toEqual([
			"the probe renders exceed the 4194304-byte bound, so the component could not be probed completely; its render must be smaller",
		]);
		const long = await sinks(inputs([{ error: `Error: ${"x".repeat(2000)}` }], textProbes(1)));
		expect(long?.errors[0]?.length).toBeLessThan(600);
	});

	it("has nothing to probe without a probed field, and keeps the render verdict apart from the sinks", async () => {
		const io = inputs([], []);
		const verdict = await judge(io);
		expect(verdict.ok).toBe(true);
		expect(await sinks(io)).toEqual({ ok: true, probes: 0, gated: 0, errors: [] });
		const failing = await judge(inputs([link(values[0] ?? ""), link("/")]));
		expect(failing.ok).toBe(true);
		expect(failing.errors).toEqual([]);
	});
});
