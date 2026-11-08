// SEC-12 (weakened CSP): the preview frame's Content-Security-Policy is exactly
// the reviewed one. Any added source, a wildcard, an unsafe keyword or a looser
// frame-ancestors is a failure. The script hash binds the frame page's exact
// import map, and the preview origin serves that policy with the page. No
// browser is needed; the browser-side behaviour is preview-origin.test.ts's.
import { createHash } from "node:crypto";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ensureHostBundles } from "../src/host-bundles.js";
import { frameCSP, framePage, importMapOf, startPreviewOrigin } from "../src/preview-origin.js";
import { loadProfiles, verifyToolchain } from "../src/profiles.js";

const self = "http://localhost:4100";
const parent = "http://127.0.0.1:4200";

function directives(csp: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const part of csp.split(";")) {
		const [name, ...sources] = part.trim().split(/\s+/);
		if (!name) continue;
		expect(out.has(name), `directive ${name} repeated`).toBe(false);
		out.set(name, sources);
	}
	return out;
}

function importMapIn(page: string): string {
	const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page);
	if (!m?.[1]) throw new Error("no import map in the frame page");
	return m[1];
}

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/** The reviewed policy for one origin pair and import map: every directive and its sources. */
function expected(selfOrigin: string, parentOrigin: string, importMap: string): Map<string, string[]> {
	return new Map([
		["default-src", ["'none'"]],
		["script-src", [selfOrigin, "blob:", sha(importMap)]],
		["style-src", [selfOrigin, "blob:"]],
		["img-src", [selfOrigin, "data:", "blob:"]],
		["font-src", [selfOrigin, "data:"]],
		["connect-src", ["'none'"]],
		["base-uri", ["'none'"]],
		["form-action", ["'none'"]],
		["frame-ancestors", [parentOrigin]],
	]);
}

const weakening = [
	"*",
	"'unsafe-inline'",
	"'unsafe-eval'",
	"'unsafe-hashes'",
	"'wasm-unsafe-eval'",
	"'strict-dynamic'",
	"http:",
	"https:",
];

function assertReviewed(csp: string, selfOrigin: string, parentOrigin: string, importMap: string): void {
	const got = directives(csp);
	expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected(selfOrigin, parentOrigin, importMap)));
	for (const [name, sources] of got) {
		for (const w of weakening) expect(sources, `${name} carries ${w}`).not.toContain(w);
	}
}

describe("preview frame CSP (SEC-12)", () => {
	const importMap = importMapOf(["react", "react-dom", "react/jsx-runtime"]);

	it("is exactly the reviewed policy: no network, no inline code but the import map, embedded by the parent only", () => {
		assertReviewed(frameCSP(self, parent, importMap), self, parent, importMap);
	});

	it("binds the frame page's exact import map: one changed byte changes the hash", () => {
		const page = framePage(parent, importMap);
		expect(importMapIn(page)).toBe(importMap);
		const csp = directives(frameCSP(self, parent, importMap));
		expect(csp.get("script-src")).toContain(sha(importMapIn(page)));
		const other = importMap.replace("/host/", "/hosx/");
		expect(other).not.toBe(importMap);
		expect(directives(frameCSP(self, parent, other)).get("script-src")).not.toContain(sha(importMap));
	});

	it("names the parent origin as the only frame ancestor, whatever it is", () => {
		const other = "https://studio.example";
		expect(directives(frameCSP(self, other, importMap)).get("frame-ancestors")).toEqual([other]);
	});

	it("is the policy the preview origin serves with the frame page", async () => {
		const profiles = loadProfiles();
		await ensureHostBundles(profiles, verifyToolchain(profiles));
		const probe = createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
		const port = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const preview = await startPreviewOrigin(`localhost:${port}`, parent);
		try {
			const { header, body, status } = await new Promise<{ header: string; body: string; status: number }>(
				(resolve, reject) => {
					get(`${preview.origin}/frame.html`, (res) => {
						let body = "";
						res.setEncoding("utf8");
						res.on("data", (c: string) => {
							body += c;
						});
						res.on("end", () =>
							resolve({
								header: String(res.headers["content-security-policy"] ?? ""),
								body,
								status: res.statusCode ?? 0,
							}),
						);
					}).on("error", reject);
				},
			);
			expect(status).toBe(200);
			assertReviewed(header, preview.origin, parent, importMapIn(body));
		} finally {
			await preview.close();
		}
	});
});
