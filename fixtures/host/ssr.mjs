// Protected SSR fixture (DD-04 §3, VAL-01). The SSR check is two steps the
// validator runs one after the other, each a separate process under its own
// identity, with nothing on disk between them:
//
//   node ssr.mjs --render   the render child: the candidate identity (UID 10001)
//   node ssr.mjs --judge    the harness: the harness identity (UID 10003)
//
// The render child is the only code that imports the candidate. It reads its
// inputs on stdin (the module path, the Puck type, the props of the two
// renders) before the import, renders the component through its own render
// function and through Puck's Render with react-dom/server, and writes one
// frame — the two rendered HTML strings and the auxiliary meta — to fd 3, the
// pipe of the trusted orchestrator. The orchestrator reads that frame only
// after it has stopped every process of the candidate identity and confirmed
// from /proc that none remains (a detached process included).
//
// The harness never imports the candidate and never runs while candidate code
// can: it gets the expectations and the render child's frame as bytes on stdin,
// re-digests the module from disk, and is the sole author of the verdict — each
// render present, non-empty and carrying the declared texts, the Puck render
// carrying the value the orchestrator chose for one text field (a value no
// file, report or frame written before the render ran can hold), the output
// digests. Its report goes to fd 3, the orchestrator's pipe, never to a file.
//
// Field sinks (the field-sinks check, after B1 run 10's security review): after
// the two renders, the render child renders the component once per probe, with
// every text and textarea field set to a hostile value the orchestrator chose
// (a javascript: URL, a data: URL, each carrying a per-run marker). The harness
// refuses a probe render that threw, a URL attribute with a javascript:,
// vbscript: or data: scheme (React's own replacement of a javascript: URL
// included: the component checks the scheme itself), and an inline style
// attribute or a <style> element that carries the marker (a text value reached
// CSS unchecked). The judge reads react-dom/server's own serialization:
// attribute values in double quotes, five characters escaped.
//
// The candidate therefore authors only data: the HTML its render returned (or
// whatever it wrote on its own descriptor, which is the same kind of data). It
// cannot write the harness's report (another process, another UID, another
// pipe), and a report, HTML or FIFO it leaves in a file is never read — a
// render that throws produces no frame with rendered output, whatever the
// candidate wrote elsewhere.
import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Render } from "@puckeditor/core";
import * as React from "react";
import { renderToString } from "react-dom/server";

const MAX_HTML_BYTES = 4 * 1024 * 1024;
// Captured before any candidate import: the render child uses these to write
// its frame and to exit even if the candidate reassigns the globals or the fs
// module's properties (a const holds the original function).
const rawExit = process.exit.bind(process);
const rawStringify = JSON.stringify;
const rawWriteSync = writeSync;

function digest(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Writes text to the orchestrator's fd 3 completely. */
function report(text) {
	const bytes = Buffer.from(text, "utf8");
	let off = 0;
	while (off < bytes.length) off += rawWriteSync(3, bytes, off, bytes.length - off);
}

function firstLines(err) {
	return String(err?.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err);
}

// react-dom/server escapes these five characters in text and attribute values,
// so a declared text appears in the rendered HTML in this form ("We'll" is
// "We&#x27;ll"); the judge looks for that form, not the raw text.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
function asRenderedHtml(text) {
	return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Decodes the character references of an attribute value (react-dom/server writes five; any other is decoded too). */
function decodeHtml(text) {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref) => {
		if (ref[0] !== "#") return HTML_ENTITIES[ref.toLowerCase()] ?? whole;
		const code =
			ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
		return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

// The attributes that carry a URL a browser follows, loads or submits to (lowercase).
const URL_ATTRIBUTES = new Set([
	"href",
	"xlink:href",
	"src",
	"action",
	"formaction",
	"poster",
	"data",
	"cite",
	"background",
	"ping",
	"srcset",
	"imagesrcset",
]);
const UNSAFE_SCHEMES = new Set(["javascript", "vbscript", "data"]);

/** The scheme a browser reads from a URL attribute value (WHATWG URL: outer C0/space stripped, tab and newline removed), lowercase, or null for a relative URL. */
function urlScheme(value) {
	let start = 0;
	let end = value.length;
	while (start < end && value.charCodeAt(start) <= 0x20) start++;
	while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
	const url = value.slice(start, end).replace(/[\t\n\r]/g, "");
	const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
	return m ? m[1].toLowerCase() : null;
}

/** Every start tag of the HTML with its attributes (name lowercase, value decoded). */
function startTags(html) {
	const tags = [];
	for (const tag of html.matchAll(
		/<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g,
	)) {
		const attributes = [];
		for (const a of tag[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
			attributes.push({ name: a[1].toLowerCase(), value: decodeHtml(a[2] ?? a[3] ?? a[4] ?? "") });
		}
		tags.push({ name: tag[1].toLowerCase(), attributes });
	}
	return tags;
}

/** What one probe render shows of a text value reaching a URL attribute or CSS: one sentence per sink, empty when none. */
function fieldSinkFindings(html, value, marker) {
	const found = [];
	const shown = JSON.stringify(value);
	for (const tag of startTags(html)) {
		for (const { name, value: attr } of tag.attributes) {
			if (URL_ATTRIBUTES.has(name)) {
				const urls = name.endsWith("srcset") ? attr.split(",").map((c) => c.trim().split(/\s+/)[0] ?? "") : [attr];
				for (const url of urls) {
					const scheme = urlScheme(url);
					if (scheme && UNSAFE_SCHEMES.has(scheme))
						found.push(
							`with every text field set to ${shown}, <${tag.name} ${name}> renders a ${scheme}: URL; a text value reaches a URL attribute only after a scheme check that keeps relative, http:, https:, mailto: and tel: URLs`,
						);
				}
			}
			if (name === "style" && attr.includes(marker))
				found.push(
					`with every text field set to ${shown}, the inline style of <${tag.name}> carries the value; a text value reaches an inline style only after it matches a fixed pattern`,
				);
		}
	}
	for (const css of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
		if (css[1].includes(marker))
			found.push(
				`with every text field set to ${shown}, a <style> element carries the value; a text value never reaches CSS`,
			);
	}
	return [...new Set(found)];
}

// The render child: candidate code runs here, with no path to the harness's
// report and no file the orchestrator reads.
async function renderChild(io) {
	const { modulePath, puckType, directProps, puckProps, probeProps } = io;
	const frame = { schemaVersion: 1, meta: { errors: [] } };
	try {
		const mod = await import(pathToFileURL(modulePath).href);
		frame.meta.exports = Object.keys(mod).sort();
		const config = mod.default;
		if (!config || typeof config !== "object") throw new Error("default export is not a Puck component config object");
		if (typeof config.render !== "function") throw new Error("default export has no render function");
		if (!config.fields || typeof config.fields !== "object") throw new Error("default export has no fields");
		if (mod.config !== config) throw new Error("named export config is not the default export");
		frame.meta.fields = Object.keys(config.fields).sort();
		const base = config.defaultProps ?? {};
		const direct = renderToString(
			React.createElement(config.render, {
				...base,
				...(directProps ?? {}),
				id: "ssr-direct",
				puck: { renderDropZone: () => null, isEditing: false, dragRef: null, metadata: {} },
			}),
		);
		const puck = renderToString(
			React.createElement(Render, {
				config: { components: { [puckType]: config } },
				data: {
					content: [{ type: puckType, props: { ...base, ...(puckProps ?? {}), id: "ssr-puck" } }],
					root: { props: {} },
				},
			}),
		);
		if (typeof direct !== "string" || typeof puck !== "string") throw new Error("a render did not return a string");
		if (direct.length > MAX_HTML_BYTES || puck.length > MAX_HTML_BYTES)
			throw new Error(`a render exceeds the ${MAX_HTML_BYTES}-byte bound`);
		frame.meta.reactVersion = React.version;
		// The field-sink probes, after both renders completed: each a render of
		// its own, so a probe that throws leaves the two renders above intact.
		const probes = [];
		let probeBytes = 0;
		for (const [i, props] of (Array.isArray(probeProps) ? probeProps : []).entries()) {
			try {
				const html = renderToString(
					React.createElement(config.render, {
						...base,
						...props,
						id: `ssr-probe-${i}`,
						puck: { renderDropZone: () => null, isEditing: false, dragRef: null, metadata: {} },
					}),
				);
				if (typeof html !== "string") throw new Error("the render did not return a string");
				probeBytes += html.length;
				if (probeBytes > MAX_HTML_BYTES) throw new Error(`the probe renders exceed the ${MAX_HTML_BYTES}-byte bound`);
				probes.push({ html });
			} catch (err) {
				probes.push({ error: firstLines(err) });
			}
		}
		// Both renders completed: only now does the frame carry rendered output.
		frame.direct = direct;
		frame.puck = puck;
		frame.probes = probes;
	} catch (err) {
		frame.meta.errors.push(firstLines(err));
	}
	try {
		report(rawStringify(frame));
	} catch {
		/* a frame that cannot be written is a missing render to the harness */
	}
	rawExit(0);
}

/**
 * The field-sinks verdict on the probe renders: one per hostile value the
 * observer chose (`probe.values`, each carrying `probe.marker`), in order.
 * A component without a text field has nothing to probe.
 */
function judgeSinks(probe, probes) {
	const values = Array.isArray(probe?.values) ? probe.values.map(String) : [];
	const sinks = { ok: false, probes: values.length, errors: [] };
	if (values.length === 0) {
		sinks.ok = true;
		return sinks;
	}
	const marker = String(probe.marker ?? "");
	if (!marker) {
		sinks.errors.push("the observer named no probe marker");
		return sinks;
	}
	if (!Array.isArray(probes) || probes.length !== values.length) {
		sinks.errors.push(
			`the render child returned ${Array.isArray(probes) ? probes.length : "no"} probe renders, the observer asked for ${values.length}`,
		);
		return sinks;
	}
	for (const [i, value] of values.entries()) {
		const p = probes[i] && typeof probes[i] === "object" ? probes[i] : {};
		if (typeof p.html !== "string") {
			sinks.errors.push(
				`the component threw when every text field held ${JSON.stringify(value)}: ${typeof p.error === "string" ? p.error : "no render"}`,
			);
			continue;
		}
		sinks.errors.push(...fieldSinkFindings(p.html, value, marker));
	}
	sinks.ok = sinks.errors.length === 0;
	return sinks;
}

// The harness: judges the render child's frame, which it receives as bytes;
// never imports the candidate.
function judge(io) {
	// uid: the identity the harness ran under, recorded as data.
	const result = { schemaVersion: 1, ok: false, errors: [], uid: process.getuid?.() };
	try {
		const bytes = readFileSync(io.modulePath);
		result.moduleDigest = digest(bytes);
		if (result.moduleDigest !== io.moduleDigest)
			throw new Error(`module on disk is ${result.moduleDigest}, the observer handed ${io.moduleDigest}`);
		let frame;
		try {
			frame = JSON.parse(io.frame ?? "");
		} catch {
			frame = undefined;
		}
		if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.schemaVersion !== 1) {
			throw new Error(
				io.frame
					? "the render child's output is not one render frame"
					: `the render child produced no rendered output (${io.renderExit ?? "no exit status"})`,
			);
		}
		const meta = frame.meta && typeof frame.meta === "object" ? frame.meta : {};
		result.exports = Array.isArray(meta.exports) ? meta.exports.map(String) : undefined;
		result.fields = Array.isArray(meta.fields) ? meta.fields.map(String) : undefined;
		const direct = frame.direct;
		const puck = frame.puck;
		if (typeof direct !== "string" || typeof puck !== "string") {
			const errors = Array.isArray(meta.errors) ? meta.errors.map(String) : [];
			throw new Error(errors.join("; ") || "the render child produced no rendered output");
		}
		if (!direct.trim()) throw new Error("the component rendered nothing");
		if (!puck.trim()) throw new Error("Puck rendered nothing for the component");
		const wantFields = [...(io.fieldNames ?? [])].sort();
		if ((result.fields ?? []).join("\n") !== wantFields.join("\n")) {
			throw new Error(
				`fields [${(result.fields ?? []).join(", ")}] differ from the declared editable fields [${wantFields.join(", ")}]`,
			);
		}
		for (const text of io.expectedTexts ?? []) {
			if (!direct.includes(asRenderedHtml(text)))
				throw new Error(`rendered HTML lacks the default text ${JSON.stringify(text)}`);
		}
		for (const text of io.puckExpectedTexts ?? []) {
			if (!puck.includes(asRenderedHtml(text)))
				throw new Error(`Puck's render lacks the default text ${JSON.stringify(text)}`);
		}
		if (io.nonce && !puck.includes(io.nonce))
			throw new Error("Puck's render lacks the value the observer chose for the render (no render with these props)");
		result.directHtmlDigest = digest(direct);
		result.puckHtmlDigest = digest(puck);
		result.htmlSample = direct.slice(0, 512);
		result.reactVersion = typeof meta.reactVersion === "string" ? meta.reactVersion : undefined;
		result.ok = true;
		result.sinks = judgeSinks(io.probe, frame.probes);
	} catch (err) {
		// The harness's own refusal: its message (the render child's errors it
		// carries are already the first lines of the candidate's stack).
		result.errors.push(String(err?.message ?? err));
	}
	report(JSON.stringify(result));
	process.exit(0);
}

const mode = process.argv[2];
if (mode !== "--render" && mode !== "--judge") {
	process.stderr.write("usage: ssr.mjs --render|--judge (inputs on stdin, report on fd 3)\n");
	process.exit(2);
}
// stdin is read and parsed here, before the candidate is imported by renderChild.
const io = JSON.parse(readFileSync(0, "utf8"));
if (mode === "--render") await renderChild(io);
else judge(io);
