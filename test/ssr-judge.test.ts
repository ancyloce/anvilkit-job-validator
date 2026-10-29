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
