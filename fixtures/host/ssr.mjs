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
// re-digests the module from disk, and is the sole author of the verdict — the
// config's field names, types and defaultProps those component.json declares
// (C11; the child reports each default only as a digest and a few fixed words),
// each render present, non-empty and carrying the declared texts, the Puck render
// carrying the value the orchestrator chose for one text field (a value no
// file, report or frame written before the render ran can hold), the output
// digests. Its report goes to fd 3, the orchestrator's pipe, never to a file.
//
// Field sinks (the field-sinks check, after B1 run 10's security review): after
// the two renders, the render child renders the component once per probe the
// orchestrator chose: with every text and textarea field set to a hostile value
// (a javascript: URL, a data: URL, markup), then with each select or radio
// field alone set to each of them, every value carrying a per-run marker;
// then, for each option a select or radio field lists in the component's own
// config, with that option opened and every text field set to one more value
// (a data: URL that is also markup), so a sink a choice gates is probed too. The
// harness refuses a probe render that threw, a URL attribute with a
// javascript:, vbscript: or data: scheme (React's own replacement of a
// javascript: URL included: the component checks the scheme itself), an inline
// style attribute or a <style> element that carries the marker (a value reached
// CSS unchecked), a <script> element that carries it, and the marker as a tag
// or attribute name or inside srcdoc (a value rendered as markup). An unsafe URL
// that the matching render without the value already has (a constant, React's
// function form action) is not a field sink. The
// judge reads react-dom/server's own serialization: attribute values in double
// quotes, five characters escaped, raw text only inside <style> and <script>.
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
// The gated field-sink probes: options opened per select or radio field, and in all.
const MAX_GATE_OPTIONS = 8;
const MAX_GATED = 32;
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

/**
 * A value's canonical JSON text (object keys sorted, no whitespace), or null
 * when it is not JSON: a function, symbol or bigint, a non-finite number, an
 * object that is not plain (a Date, a class instance), an undefined array
 * item, a React element (its $$typeof is a symbol), or a cycle or throwing
 * getter (the caller catches the error).
 */
function canonicalJson(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return rawStringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? rawStringify(value) : null;
	if (Array.isArray(value)) {
		const items = [];
		for (const item of value) {
			const text = canonicalJson(item);
			if (text === null) return null;
			items.push(text);
		}
		return `[${items.join(",")}]`;
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return null;
		const members = [];
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			const text = canonicalJson(value[key]);
			if (text === null) return null;
			members.push(`${rawStringify(key)}:${text}`);
		}
		return `{${members.join(",")}}`;
	}
	return null;
}

/** "an array of 4 items": a few fixed words for a canonical JSON text, never the value itself. */
function describeJson(text) {
	const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
	if (text === '""') return "an empty string";
	if (text.startsWith('"')) return "a string";
	if (text === "[]") return "an empty array";
	if (text.startsWith("[")) return `an array of ${count(JSON.parse(text).length, "item")}`;
	if (text === "{}") return "an empty object";
	if (text.startsWith("{")) return `an object with ${count(Object.keys(JSON.parse(text)).length, "key")}`;
	if (text === "true" || text === "false" || text === "null") return text;
	return "a number";
}

/**
 * The fingerprint of one field's default in a props object (C11): the digest
 * of its canonical JSON with a short description, "absent" for no own value
 * (or undefined), "not-json" for a value JSON cannot hold.
 */
function defaultFingerprint(props, name) {
	try {
		if (!Object.hasOwn(props, name) || props[name] === undefined) return { digest: "absent", kind: "no default" };
		const text = canonicalJson(props[name]);
		if (text === null) return { digest: "not-json", kind: "a value that is not JSON" };
		return { digest: digest(text), kind: describeJson(text) };
	} catch {
		return { digest: "not-json", kind: "a value that is not JSON" };
	}
}
/** The descriptions describeJson and defaultFingerprint write: the only ones a verdict repeats from the child. */
const DEFAULT_KIND =
	/^(no default|a value that is not JSON|an empty string|a string|an empty array|an array of [1-9][0-9]{0,8} items?|an empty object|an object with [1-9][0-9]{0,8} keys?|true|false|null|a number)$/;

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

/**
 * Every start tag of the HTML with its attributes (name lowercase, value
 * decoded). A name never holds "<", so an unclosed tag ends at the next one
 * and the scan stays linear in the HTML.
 */
function startTags(html) {
	const tags = [];
	for (const tag of html.matchAll(
		/<([a-zA-Z][a-zA-Z0-9:._-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g,
	)) {
		const attributes = [];
		for (const a of tag[2].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
			attributes.push({ name: a[1].toLowerCase(), value: decodeHtml(a[2] ?? a[3] ?? a[4] ?? "") });
		}
		tags.push({ name: tag[1].toLowerCase(), attributes });
	}
	return tags;
}

/** <style> and <script> elements: react-dom/server escapes only their end tag in their raw text. */
const RAW_TEXT = /(<(style|script)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi;

/** The raw text of an HTML render and its markup with that text blanked (start tags and their attributes kept). */
function splitRawText(html) {
	const raw = [];
	const markup = html.replace(RAW_TEXT, (_whole, open, name, body, close) => {
		raw.push({ name: name.toLowerCase(), body });
		return open + close;
	});
	return { raw, markup };
}

// React writes this URL itself for a function form action or formAction; no field value produces it.
const REACT_FORM_ACTION = "javascript:throw new Error('React form unexpectedly submitted.')";

/** The unsafe-scheme URLs of a render's start tags, keyed by tag, attribute and URL. */
function unsafeUrls(tags) {
	const found = [];
	for (const tag of tags) {
		for (const { name, value } of tag.attributes) {
			if (!URL_ATTRIBUTES.has(name)) continue;
			const urls = name.endsWith("srcset") ? value.split(",").map((c) => c.trim().split(/\s+/)[0] ?? "") : [value];
			for (const url of urls) {
				if (url.trim() === REACT_FORM_ACTION) continue;
				const scheme = urlScheme(url);
				if (scheme && UNSAFE_SCHEMES.has(scheme))
					found.push({ key: `${tag.name}\u0000${name}\u0000${url}`, tag: tag.name, name, scheme });
			}
		}
	}
	return found;
}

/**
 * What one probe render shows of a field value reaching a sink: one sentence
 * per sink, empty when none. `probe` describes the render: its value, the
 * select or radio field it set alone (`field`, `type`), or the select or
 * radio option it opened beside the text values (`gate`). An unsafe URL that
 * the baseline render (the same props without the hostile value) already
 * has is the component's own constant, not a field sink, and is not counted.
 */
function fieldSinkFindings(html, baselineHtml, probe, marker) {
	const found = [];
	const shown = JSON.stringify(probe.value);
	const choice = typeof probe.field === "string";
	const where = choice
		? `with the ${probe.type} field ${probe.field} set to ${shown}`
		: probe.gate
			? `with every text field set to ${shown} and the ${probe.gate.type} field ${probe.gate.field} set to ${JSON.stringify(probe.gate.option)}`
			: `with every text field set to ${shown}`;
	const urlRule = choice
		? "a select or radio value reaches a URL attribute only after it matches one of the field's options"
		: "a text value reaches a URL attribute only after a scheme check that keeps relative, http:, https:, mailto: and tel: URLs";
	const styleRule = choice
		? "a select or radio value reaches an inline style only after it matches one of the field's options"
		: "a text value reaches an inline style only after it matches a fixed pattern";
	const { raw, markup } = splitRawText(html);
	for (const r of raw) {
		if (!r.body.includes(marker)) continue;
		found.push(
			r.name === "style"
				? `${where}, a <style> element carries the value; a field value never reaches CSS`
				: `${where}, a <script> element carries the value; a field value never reaches a script`,
		);
	}
	const tags = startTags(markup);
	const known = new Map();
	for (const u of unsafeUrls(startTags(splitRawText(baselineHtml).markup)))
		known.set(u.key, (known.get(u.key) ?? 0) + 1);
	for (const u of unsafeUrls(tags)) {
		const left = known.get(u.key) ?? 0;
		if (left > 0) {
			known.set(u.key, left - 1);
			continue;
		}
		found.push(`${where}, <${u.tag} ${u.name}> renders a ${u.scheme}: URL; ${urlRule}`);
	}
	for (const tag of tags) {
		if (
			tag.name.includes(marker) ||
			tag.attributes.some((a) => a.name.includes(marker) || (a.name === "srcdoc" && a.value.includes(`<${marker}`)))
		)
			found.push(
				`${where}, the value is rendered as markup; a field value reaches the page only as React text or an attribute value, never through dangerouslySetInnerHTML or srcdoc`,
			);
		for (const { name, value } of tag.attributes) {
			if (name === "style" && value.includes(marker))
				found.push(`${where}, the inline style of <${tag.name}> carries the value; ${styleRule}`);
		}
	}
	return [...new Set(found)];
}

// The render child: candidate code runs here, with no path to the harness's
// report and no file the orchestrator reads.
async function renderChild(io) {
	const { modulePath, puckType, directProps, puckProps, probeProps, gate } = io;
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
		frame.meta.fieldTypes = Object.fromEntries(
			frame.meta.fields.map((name) => [
				name,
				typeof config.fields[name]?.type === "string" ? config.fields[name].type : null,
			]),
		);
		const base = config.defaultProps ?? {};
		if (typeof base !== "object" || base === null || Array.isArray(base))
			throw new Error("default export's defaultProps is not an object");
		// Each declared field's default as defaultProps holds it (C11), fingerprinted
		// before any render can change it; the harness compares it with the declaration.
		frame.meta.defaults = Object.fromEntries(frame.meta.fields.map((name) => [name, defaultFingerprint(base, name)]));
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
		// All probe renders share one byte bound; past it the rest is not
		// rendered and the frame says so (probeLimit).
		const probe = (props, key) =>
			renderToString(
				React.createElement(config.render, {
					...base,
					...props,
					id: `ssr-probe-${key}`,
					puck: { renderDropZone: () => null, isEditing: false, dragRef: null, metadata: {} },
				}),
			);
		let probeBytes = 0;
		let limited = false;
		const attempt = (props, key) => {
			if (limited) return { limited: true };
			try {
				const html = probe(props, key);
				if (typeof html !== "string") throw new Error("the render did not return a string");
				probeBytes += html.length;
				if (probeBytes > MAX_HTML_BYTES) {
					limited = true;
					return { limited: true };
				}
				return { html };
			} catch (err) {
				return { error: firstLines(err) };
			}
		};
		const probes = (Array.isArray(probeProps) ? probeProps : []).map((props, i) => attempt(props, i));
		// The gated probes: the text values again with each select or radio
		// option opened that differs from the field's default (the options as
		// the component's own Puck config lists them), each beside a baseline
		// render of that option without the text values. Bounded per field and
		// in total.
		const gated = [];
		const gateFields = Array.isArray(gate?.fields) ? gate.fields.map(String) : [];
		for (const field of gateFields) {
			const values = [];
			try {
				const options = Array.isArray(config.fields?.[field]?.options) ? config.fields[field].options : [];
				for (const o of options) {
					const v = o && typeof o === "object" ? o.value : undefined;
					if (["string", "number", "boolean"].includes(typeof v) && v !== base[field] && !values.includes(v))
						values.push(v);
				}
			} catch {
				// options that cannot be read open no gate; the probes above still ran
			}
			for (const option of values.slice(0, MAX_GATE_OPTIONS)) {
				if (gated.length >= MAX_GATED) break;
				const baseline = attempt({ [field]: option }, `gate-${gated.length}-base`);
				const html = attempt({ ...(gate.props ?? {}), [field]: option }, `gate-${gated.length}`);
				gated.push({ field, option, baseline, probe: html });
			}
		}
		if (limited) frame.probeLimit = { bound: MAX_HTML_BYTES };
		// Both renders completed: only now does the frame carry rendered output.
		frame.direct = direct;
		frame.puck = puck;
		frame.probes = probes;
		frame.gated = gated;
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

/** The most field-sink sentences a verdict carries; the rest are counted. */
const MAX_SINK_ERRORS = 8;
/** The longest render error a sentence quotes. */
const MAX_ERROR_CHARS = 400;

function renderError(p) {
	return typeof p?.error === "string" ? p.error.slice(0, MAX_ERROR_CHARS) : "no render";
}

/**
 * The field-sinks verdict on the probe renders of the frame: one per probe the
 * observer described (`probe.probes`: each a value carrying `probe.marker`
 * and, for a select or radio probe, its field and type), in order, then the
 * gated renders the render child made with `probe.gateValue` (each judged
 * against its own baseline). A component without a text, textarea, select or
 * radio field has nothing to probe.
 */
function judgeSinks(probe, frame) {
	const asked = Array.isArray(probe?.probes) ? probe.probes : [];
	const sinks = { ok: false, probes: asked.length, gated: 0, errors: [] };
	if (asked.length === 0) {
		sinks.ok = true;
		return sinks;
	}
	const marker = String(probe.marker ?? "");
	if (!marker) {
		sinks.errors.push("the observer named no probe marker");
		return sinks;
	}
	const probes = frame?.probes;
	if (!Array.isArray(probes) || probes.length !== asked.length) {
		sinks.errors.push(
			`the render child returned ${Array.isArray(probes) ? probes.length : "no"} probe renders, the observer asked for ${asked.length}`,
		);
		return sinks;
	}
	const baseline = typeof frame.direct === "string" ? frame.direct : "";
	const errors = [];
	for (const [i, d] of asked.entries()) {
		const described = {
			value: String(d?.value ?? ""),
			...(typeof d?.field === "string" ? { field: d.field, type: String(d.type ?? "select") } : {}),
		};
		const p = probes[i] && typeof probes[i] === "object" ? probes[i] : {};
		if (p.limited) continue;
		if (typeof p.html !== "string") {
			const held = described.field ? `the ${described.type} field ${described.field} held` : "every text field held";
			errors.push(`the component threw when ${held} ${JSON.stringify(described.value)}: ${renderError(p)}`);
			continue;
		}
		errors.push(...fieldSinkFindings(p.html, baseline, described, marker));
	}
	const types = new Map(
		asked.filter((d) => typeof d?.field === "string").map((d) => [d.field, String(d.type ?? "select")]),
	);
	for (const g of Array.isArray(frame.gated) ? frame.gated.slice(0, MAX_GATED) : []) {
		if (!g || typeof g !== "object") continue;
		const gate = { field: String(g.field), type: types.get(String(g.field)) ?? "select", option: g.option };
		const opened = `the ${gate.type} field ${gate.field} held ${JSON.stringify(gate.option)}`;
		if (g.baseline?.limited || g.probe?.limited) continue;
		if (typeof g.baseline?.html !== "string") {
			errors.push(`the component threw when ${opened}: ${renderError(g.baseline)}`);
			continue;
		}
		const value = String(probe.gateValue ?? "");
		if (typeof g.probe?.html !== "string") {
			errors.push(
				`the component threw when every text field held ${JSON.stringify(value)} and ${opened}: ${renderError(g.probe)}`,
			);
			continue;
		}
		sinks.gated += 1;
		errors.push(...fieldSinkFindings(g.probe.html, g.baseline.html, { value, gate }, marker));
	}
	if (frame.probeLimit)
		errors.push(
			`the probe renders exceed the ${Number(frame.probeLimit.bound) || "fixed"}-byte bound, so the component could not be probed completely; its render must be smaller`,
		);
	const unique = [...new Set(errors)];
	sinks.errors =
		unique.length > MAX_SINK_ERRORS
			? [...unique.slice(0, MAX_SINK_ERRORS), `and ${unique.length - MAX_SINK_ERRORS} more`]
			: unique;
	sinks.ok = unique.length === 0;
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
		// Each declared editable field has the type its Puck field has: the observer
		// judges defaults and probes by the declared type (the v0.1.36 complex
		// component declared radio, select, external and custom fields as text and
		// failed C16 on a choice's default). The child's types are candidate data:
		// only a type-like word is repeated in the message.
		if (io.fieldTypes && typeof io.fieldTypes === "object") {
			const got =
				meta.fieldTypes && typeof meta.fieldTypes === "object" && !Array.isArray(meta.fieldTypes)
					? meta.fieldTypes
					: {};
			const shown = (t) => (typeof t === "string" && /^[a-z]{1,16}$/.test(t) ? t : "no field type");
			const differ = wantFields
				.filter((name) => got[name] !== io.fieldTypes[name])
				.map(
					(name) => `${name} is ${shown(got[name])} in the Puck config and ${io.fieldTypes[name]} in component.json`,
				);
			if (differ.length)
				throw new Error(
					`field types differ from the declared editable fields: ${differ.join("; ")}; each editableFields type is the type of the Puck field of that name (a fixed choice is select or radio in both)`,
				);
		}
		// The observer names the field that owns each default and the remedy
		// (DEC-043); both are its data, appended to the judge's own sentence.
		const owner = (text) => {
			const f = io.defaultFields && typeof io.defaultFields === "object" ? io.defaultFields[text] : undefined;
			return typeof f === "string" && f ? ` of the ${f}` : "";
		};
		const remedy = typeof io.remedy === "string" && io.remedy ? `; ${io.remedy}` : "";
		for (const text of io.expectedTexts ?? []) {
			if (!direct.includes(asRenderedHtml(text)))
				throw new Error(`rendered HTML lacks the default text ${JSON.stringify(text)}${owner(text)}${remedy}`);
		}
		for (const text of io.puckExpectedTexts ?? []) {
			if (!puck.includes(asRenderedHtml(text)))
				throw new Error(`Puck's render lacks the default text ${JSON.stringify(text)}${owner(text)}${remedy}`);
		}
		if (io.nonce && !puck.includes(io.nonce))
			throw new Error("Puck's render lacks the value the observer chose for the render (no render with these props)");
		// C11: defaultProps carries the declared defaults. The observer renders and
		// judges the declared defaults (its props override defaultProps), so a
		// declaration that differs certifies a first render Puck never shows: the
		// v0.1.38 footer declared its metrics and links empty beside four metrics
		// and six links in defaultProps, and certification rendered them empty. A
		// field without a declared default has none in defaultProps, or that default
		// reaches the first render unjudged (C16). The child's descriptions are
		// candidate data: only a known phrase is repeated. Judged once the frame is
		// shown to be this run's render (the value above), so a forged frame is named as one.
		if (io.declaredDefaults && typeof io.declaredDefaults === "object") {
			const got =
				meta.defaults && typeof meta.defaults === "object" && !Array.isArray(meta.defaults) ? meta.defaults : {};
			const shown = (k) => (typeof k === "string" && DEFAULT_KIND.test(k) ? k : "an undescribed value");
			const differ = [];
			for (const name of wantFields) {
				const want = defaultFingerprint(io.declaredDefaults, name);
				const have = got[name] && typeof got[name] === "object" ? got[name] : {};
				if (have.digest !== want.digest)
					differ.push(`${name} is ${shown(have.kind)} in defaultProps and ${want.kind} in component.json`);
			}
			if (differ.length)
				throw new Error(
					`default values differ from the declared defaults: ${differ.join("; ")}; each declared field's defaultProps value is its editableFields default, the same JSON value, and a field without a declared default has none in defaultProps (C11): the validator renders and judges the declared defaults, so they must be the component's first render`,
				);
		}
		result.directHtmlDigest = digest(direct);
		result.puckHtmlDigest = digest(puck);
		result.htmlSample = direct.slice(0, 512);
		result.reactVersion = typeof meta.reactVersion === "string" ? meta.reactVersion : undefined;
		result.ok = true;
		result.sinks = judgeSinks(io.probe, frame);
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
