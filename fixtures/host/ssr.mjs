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

// The render child: candidate code runs here, with no path to the harness's
// report and no file the orchestrator reads.
async function renderChild(io) {
	const { modulePath, puckType, directProps, puckProps } = io;
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
		// Both renders completed: only now does the frame carry rendered output.
		frame.direct = direct;
		frame.puck = puck;
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
			if (!direct.includes(text)) throw new Error(`rendered HTML lacks the default text ${JSON.stringify(text)}`);
		}
		for (const text of io.puckExpectedTexts ?? []) {
			if (!puck.includes(text)) throw new Error(`Puck's render lacks the default text ${JSON.stringify(text)}`);
		}
		if (io.nonce && !puck.includes(io.nonce))
			throw new Error("Puck's render lacks the value the observer chose for the render (no render with these props)");
		result.directHtmlDigest = digest(direct);
		result.puckHtmlDigest = digest(puck);
		result.htmlSample = direct.slice(0, 512);
		result.reactVersion = typeof meta.reactVersion === "string" ? meta.reactVersion : undefined;
		result.ok = true;
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
