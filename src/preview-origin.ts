// The separate preview origin of anvilkit-preview-v1 (DD-04 §5, DD-05 §4;
// DEVELOPMENT_ONLY placement until ENV-08 names the real preview origin and
// CSP). It serves exactly three kinds of resource and nothing else:
//
//   /frame.html   the frame page: the Host ABI's import map, the parent
//                 origin it accepts a bootstrap from, a CSP that allows
//                 scripts and styles only from this origin and blob: URLs
//                 (the verified preview module and stylesheets), no
//                 network access, and embedding only by the parent origin;
//   /frame.js     the protected frame script (fixtures/preview/frame.tsx);
//   /host/*.js    the Host ABI runtime bundles (one React, one ReactDOM,
//                 one Puck), built by host-bundles for the reviewed profiles.
//
// Studio embeds /frame.html in an iframe sandboxed with allow-scripts and
// never allow-same-origin, so the document's origin is opaque: every
// module request is cross-origin and answered with an open CORS header.
// The server holds no credential and serves no preview bytes: those reach
// the frame only through the bound MessageChannel.
//
//   node dist/preview-origin.js --listen 127.0.0.1:18790 --parent-origin http://localhost:3000
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleName, bundleScript, hostBundleDir } from "./host-bundles.js";
import { loadProfiles } from "./profiles.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameSource = path.join(packageRoot, "fixtures", "preview", "frame.tsx");
const frameDir = path.join(packageRoot, "fixtures", "preview", "dist");

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function sha256(b: Buffer): string {
	return createHash("sha256").update(b).digest("hex");
}

/** The frame page for one parent origin and one serving origin. */
export function importMapOf(externals: string[]): string {
	const imports: Record<string, string> = {};
	for (const s of externals) imports[s] = `/host/${bundleName(s)}`;
	return JSON.stringify({ imports });
}

export function framePage(parentOrigin: string, importMap: string): string {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="anvilkit-parent-origin" content="${esc(parentOrigin)}" />
<title>anvilkit preview</title>
<script type="importmap">${importMap}</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="/frame.js"></script>
</body>
</html>
`;
}

/** The CSP of the frame page: this origin, blob: and the exact import map only, no network, embedded by the parent only. */
export function frameCSP(selfOrigin: string, parentOrigin: string, importMap: string): string {
	const importMapHash = createHash("sha256").update(importMap).digest("base64");
	return [
		"default-src 'none'",
		`script-src ${selfOrigin} blob: 'sha256-${importMapHash}'`,
		`style-src ${selfOrigin} blob:`,
		`img-src ${selfOrigin} data: blob:`,
		`font-src ${selfOrigin} data:`,
		"connect-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors ${parentOrigin}`,
	].join("; ");
}

async function ensureFrameBundle(externals: string[]): Promise<Buffer> {
	const out = path.join(frameDir, "frame.js");
	const stamp = path.join(frameDir, "frame.source.sha256");
	const source = sha256(readFileSync(frameSource));
	if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === source) return readFileSync(out);
	mkdirSync(frameDir, { recursive: true });
	await bundleScript(frameSource, externals, out);
	writeFileSync(stamp, source);
	return readFileSync(out);
}

export interface PreviewOrigin {
	close(): Promise<void>;
	origin: string;
}

export async function startPreviewOrigin(listen: string, parentOrigin: string): Promise<PreviewOrigin> {
	const profiles = loadProfiles();
	const externals = Object.keys(profiles.host.externals).sort();
	const runtime = new Map<string, Buffer>();
	for (const s of externals) {
		const f = path.join(hostBundleDir, bundleName(s));
		if (!existsSync(f)) throw new Error(`host bundle ${bundleName(s)} is missing: run node dist/host-bundles.js first`);
		runtime.set(`/host/${bundleName(s)}`, readFileSync(f));
	}
	const frame = await ensureFrameBundle(externals);
	const [host = "127.0.0.1", port = "0"] = listen.split(":");
	const selfOrigin = `http://${host}:${port}`;
	const importMap = importMapOf(externals);
	const page = framePage(parentOrigin, importMap);
	const csp = frameCSP(selfOrigin, parentOrigin, importMap);
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Cache-Control", "no-store");
		if (req.method !== "GET") {
			res.writeHead(405).end();
			return;
		}
		const url = (req.url ?? "/").split("?")[0] ?? "/";
		if (url === "/frame.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp });
			res.end(page);
			return;
		}
		const body = url === "/frame.js" ? frame : runtime.get(url);
		if (!body) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/javascript; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
			"Content-Length": String(body.length),
		});
		res.end(body);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(port), host, () => resolve());
	});
	return {
		origin: selfOrigin,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const listen = arg("--listen") ?? "127.0.0.1:18790";
	const parentOrigin = arg("--parent-origin");
	if (!parentOrigin || !/^https?:\/\/[^/]+$/.test(parentOrigin)) {
		console.error("usage: preview-origin --listen host:port --parent-origin http(s)://host[:port]");
		process.exit(2);
	}
	const origin = await startPreviewOrigin(listen, parentOrigin);
	console.log(JSON.stringify({ previewOrigin: origin.origin, parentOrigin }));
}
