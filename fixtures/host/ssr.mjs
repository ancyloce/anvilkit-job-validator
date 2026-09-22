// Protected SSR fixture (DD-04 §3). The trusted observation boundary of the
// SSR check: candidate code and the trusted verdict never share a process, and
// — the P10-F01 repair — the trusted verdict is never assembled with primitives
// the candidate could have poisoned.
//
// This file runs in two modes:
//
//   node ssr.mjs <expectations.json> <result.json>   the trusted harness
//   node ssr.mjs --render                            the candidate render child
//
// The harness (the step the validator spawns) NEVER imports the candidate. It
// re-digests the module from disk, spawns the render child, and hands it — on
// stdin, consumed before the candidate is imported and never on argv or in the
// environment, so the candidate cannot learn them — the module path, the render
// inputs and the paths of the two files the child must fill. The child imports
// the candidate, renders it twice (its own render function and through Puck's
// Render), and only when BOTH renders complete writes the two rendered HTML
// strings, as raw bytes, to those files with the `writeFileSync` binding it
// imported (an ES module binding the candidate cannot reassign). The harness
// then reads those files back and is the sole author of the verdict: it checks
// each render is present, non-empty and carries the declared texts, and it
// computes the output digests.
//
// The evidence source is therefore the rendered HTML itself, read by trusted
// code, not a report the child serialized: the child reports no `ok` flag the
// harness trusts, and the harness reads the child's stdout only for diagnostics.
// A candidate that throws during SSR leaves no HTML behind, and a candidate that
// poisons JSON.stringify or process.stdout.write after import cannot rewrite an
// evidence file it never wrote and whose path it never saw. The child is given
// neither the result path nor the expected texts, so it can only return what it
// actually rendered.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Render } from "@puckeditor/core";
import * as React from "react";
import { renderToString } from "react-dom/server";

const selfPath = fileURLToPath(import.meta.url);
const CHILD_TIMEOUT_MS = 110_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// Captured before any candidate import: the render child uses these to leave its
// auxiliary report and to exit even if the candidate reassigns the globals.
const rawExit = process.exit.bind(process);
const rawStringify = JSON.stringify;

function digest(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// The render child: candidate code runs here, in its own process, with no
// access to the result path and no way to write the harness's report. Its only
// trusted output is the raw rendered HTML written to the two paths handed on
// stdin; everything else (the auxiliary meta, its stdout) is data.
async function renderChild(io) {
	const { modulePath, puckType, defaultProps, directPath, puckPath, metaPath } = io;
	const meta = { errors: [] };
	try {
		const mod = await import(pathToFileURL(modulePath).href);
		meta.exports = Object.keys(mod).sort();
		const config = mod.default;
		if (!config || typeof config !== "object") throw new Error("default export is not a Puck component config object");
		if (typeof config.render !== "function") throw new Error("default export has no render function");
		if (!config.fields || typeof config.fields !== "object") throw new Error("default export has no fields");
		if (mod.config !== config) throw new Error("named export config is not the default export");
		meta.fields = Object.keys(config.fields).sort();
		const props = { ...(config.defaultProps ?? {}), ...(defaultProps ?? {}) };
		const directHtml = renderToString(
			React.createElement(config.render, {
				...props,
				id: "ssr-direct",
				puck: { renderDropZone: () => null, isEditing: false, dragRef: null, metadata: {} },
			}),
		);
		const puckHtml = renderToString(
			React.createElement(Render, {
				config: { components: { [puckType]: config } },
				data: { content: [{ type: puckType, props: { id: "ssr-puck", ...props } }], root: { props: {} } },
			}),
		);
		if (typeof directHtml !== "string" || typeof puckHtml !== "string")
			throw new Error("a render did not return a string");
		meta.reactVersion = React.version;
		// Both renders completed: write the raw HTML the harness will read and
		// digest. A render that throws above never reaches here, so neither file
		// is written and the harness treats the missing render as a failed one —
		// no `ok` from the child is ever trusted.
		writeFileSync(directPath, directHtml);
		writeFileSync(puckPath, puckHtml);
	} catch (err) {
		meta.errors.push(String(err?.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
	}
	// Auxiliary only: exports/fields/reactVersion the harness cross-checks
	// against the static facts, and the error text for diagnostics. The verdict
	// is the raw HTML, never this file, so its serialization is not on the
	// trusted path.
	try {
		writeFileSync(metaPath, rawStringify(meta));
	} catch {
		/* auxiliary; the missing HTML is what the harness decides on */
	}
	rawExit(0);
}

/** The rendered HTML the child left at `p`, or undefined when the render did not produce it. */
function readRender(p) {
	if (!existsSync(p)) return undefined;
	if (statSync(p).size > MAX_OUTPUT_BYTES) throw new Error(`${basename(p)} exceeds the ${MAX_OUTPUT_BYTES}-byte bound`);
	return readFileSync(p, "utf8");
}

function readJson(p) {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return {};
	}
}

// The trusted harness: never imports the candidate; decides from the rendered
// HTML the child wrote and writes the report.
function harness(expectationsPath, resultPath) {
	const result = { ok: false, errors: [], schemaVersion: 1 };
	try {
		const want = JSON.parse(readFileSync(expectationsPath, "utf8"));
		const bytes = readFileSync(want.modulePath);
		result.moduleDigest = digest(bytes);
		if (result.moduleDigest !== want.moduleDigest)
			throw new Error(`module on disk is ${result.moduleDigest}, the observer handed ${want.moduleDigest}`);
		const dir = dirname(resultPath);
		const directPath = join(dir, "ssr-direct.html");
		const puckPath = join(dir, "ssr-puck.html");
		const metaPath = join(dir, "ssr-meta.json");
		for (const p of [directPath, puckPath, metaPath])
			if (existsSync(p)) throw new Error(`a render artifact (${basename(p)}) exists before the render ran`);
		const child = spawnSync(process.execPath, [selfPath, "--render"], {
			cwd: process.cwd(),
			// The paths and inputs go on stdin, which the child consumes before it
			// imports the candidate; the candidate never sees them.
			input: rawStringify({
				modulePath: want.modulePath,
				puckType: want.puckType,
				defaultProps: want.defaultProps ?? {},
				directPath,
				puckPath,
				metaPath,
			}),
			encoding: "utf8",
			timeout: CHILD_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
		});
		// The child's stdout, stderr and exit code are diagnostic only. The
		// verdict is the raw HTML the trusted child wrote and this harness reads:
		// a render that threw wrote none, whatever the child (or a poisoned
		// JSON.stringify/process.stdout.write) may have printed.
		const meta = readJson(metaPath);
		result.exports = meta.exports;
		result.fields = meta.fields;
		const direct = readRender(directPath);
		const puck = readRender(puckPath);
		if (direct === undefined || puck === undefined) {
			const why =
				(meta.errors ?? []).join("; ") ||
				(child.error ? child.error.message : null) ||
				`the render child produced no rendered output (exit ${child.status}, signal ${child.signal})`;
			throw new Error(why);
		}
		if (!direct.trim()) throw new Error("the component rendered nothing");
		if (!puck.trim()) throw new Error("Puck rendered nothing for the component");
		const wantFields = [...(want.fieldNames ?? [])].sort();
		if ((meta.fields ?? []).join("\n") !== wantFields.join("\n")) {
			throw new Error(
				`fields [${(meta.fields ?? []).join(", ")}] differ from the declared editable fields [${wantFields.join(", ")}]`,
			);
		}
		for (const text of want.expectedTexts ?? []) {
			if (!direct.includes(text)) throw new Error(`rendered HTML lacks the default text ${JSON.stringify(text)}`);
			if (!puck.includes(text)) throw new Error(`Puck's render lacks the default text ${JSON.stringify(text)}`);
		}
		result.directHtmlDigest = digest(direct);
		result.puckHtmlDigest = digest(puck);
		result.htmlSample = direct.slice(0, 512);
		result.reactVersion = meta.reactVersion;
		result.ok = true;
	} catch (err) {
		result.errors.push(String(err?.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err));
	}
	writeFileSync(resultPath, JSON.stringify(result));
	process.exit(result.ok ? 0 : 1);
}

if (process.argv[2] === "--render") {
	// stdin (the module path, render inputs and the output paths) is read and
	// parsed here, before the candidate is imported by renderChild.
	await renderChild(JSON.parse(readFileSync(0, "utf8")));
} else {
	const [expectationsPath, resultPath] = process.argv.slice(2);
	if (!expectationsPath || !resultPath) {
		process.stderr.write("usage: ssr.mjs <expectations.json> <result.json>\n");
		process.exit(2);
	}
	harness(expectationsPath, resultPath);
}
