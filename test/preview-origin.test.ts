// anvilkit-preview-v1 in a real browser: a parent page on one origin embeds
// the preview frame from the separate preview origin in an iframe
// sandboxed with allow-scripts only, bootstraps one session over a
// MessageChannel and renders a module through the Host ABI runtime. The
// protocol's refusals are exercised the same way: a module whose bytes do
// not match its digest, a message out of sequence and a second bootstrap.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHostBundles } from "../src/host-bundles.js";
import { type PreviewOrigin, startPreviewOrigin } from "../src/preview-origin.js";
import { loadProfiles, verifyToolchain } from "../src/profiles.js";

const moduleText = `import { createElement } from "react";
export default {
  fields: { title: { type: "text" } },
  defaultProps: { title: "default title" },
  render: (props) => createElement("h1", { id: "preview-title" }, props.title),
};
`;
const cssText = "#preview-title { color: rgb(1, 2, 3); }";
const digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

let parent: Server;
let parentOrigin: string;
let preview: PreviewOrigin;
let browser: Browser;

function parentPage(frameUrl: string): string {
	return `<!doctype html><html><body>
<iframe id="preview" sandbox="allow-scripts" src="${frameUrl}"></iframe>
<script>
window.previewLog = [];
window.startSession = (session, nonce) => {
  const channel = new MessageChannel();
  window.previewPort = channel.port1;
  channel.port1.onmessage = (ev) => window.previewLog.push(ev.data);
  document.getElementById("preview").contentWindow.postMessage(
    { type: "anvilkit.preview.bootstrap", protocol: "anvilkit-preview-v1", session, nonce, parentOrigin: location.origin }, "*", [channel.port2]);
};
window.send = (m) => window.previewPort.postMessage(m);
window.rebootstrap = (session, nonce) => {
  const c = new MessageChannel();
  document.getElementById("preview").contentWindow.postMessage(
    { type: "anvilkit.preview.bootstrap", protocol: "anvilkit-preview-v1", session, nonce, parentOrigin: location.origin }, "*", [c.port2]);
};
</script></body></html>`;
}

beforeAll(async () => {
	const profiles = loadProfiles();
	await ensureHostBundles(profiles, verifyToolchain(profiles));
	parent = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(parentPage(`${preview.origin}/frame.html`));
	});
	await new Promise<void>((r) => parent.listen(0, "127.0.0.1", () => r()));
	parentOrigin = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`;
	const probe = createServer();
	await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>((r) => probe.close(() => r()));
	// The preview origin differs from the parent's by host (localhost vs 127.0.0.1).
	preview = await startPreviewOrigin(`localhost:${port}`, parentOrigin);
	browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
	await browser?.close();
	await preview?.close();
	await new Promise<void>((r) => parent.close(() => r()));
});

async function open(): Promise<{ page: Page; frame: Frame }> {
	const page = await browser.newPage();
	await page.goto(parentOrigin);
	const frame = page.frames().find((f) => f.url().startsWith(preview.origin));
	if (!frame) throw new Error("no preview frame");
	await frame.waitForFunction(() => document.documentElement.dataset.previewStatus === "waiting");
	return { page, frame };
}

const log = (page: Page) =>
	page.evaluate(() => (window as unknown as { previewLog: Record<string, unknown>[] }).previewLog);
const status = (frame: Frame) => frame.evaluate(() => document.documentElement.dataset.previewStatus);

describe("anvilkit-preview-v1", () => {
	it("bootstraps one session and renders the verified module with its stylesheet", async () => {
		const { page, frame } = await open();
		await page.evaluate(() =>
			(window as unknown as { startSession: (s: string, n: string) => void }).startSession(
				"sess_0123456789abcdef",
				"0123456789abcdef0123456789abcdef",
			),
		);
		await expect.poll(async () => (await log(page))[0]?.type).toBe("ready");
		const ready = (await log(page))[0];
		expect(ready).toMatchObject({
			seq: 1,
			nonce: "0123456789abcdef0123456789abcdef",
			hostProfileId: "host-abi-dev-v1",
			session: "sess_0123456789abcdef",
		});
		const render = {
			type: "render",
			session: "sess_0123456789abcdef",
			seq: 1,
			previewRevision: "4",
			puckType: "Hero",
			module: { digest: digest(moduleText), text: moduleText },
			styles: [{ digest: digest(cssText), text: cssText }],
			props: { title: "saved revision 4" },
		};
		await page.evaluate((m) => (window as unknown as { send: (m: unknown) => void }).send(m), render);
		await expect.poll(async () => (await log(page))[1]?.type).toBe("rendered");
		expect((await log(page))[1]).toMatchObject({ seq: 2, renderSeq: 1, previewRevision: "4" });
		expect(await frame.textContent("#preview-title")).toBe("saved revision 4");
		expect(
			await frame.evaluate(() => getComputedStyle(document.getElementById("preview-title") as Element).color),
		).toBe("rgb(1, 2, 3)");
		// The sandboxed frame has an opaque origin: it reaches nothing of the parent.
		expect(
			await frame.evaluate(() => {
				try {
					return String(window.parent.document);
				} catch {
					return "blocked";
				}
			}),
		).toBe("blocked");
		await page.close();
	});

	it("refuses bytes that do not match their digest, then closes on disorder", async () => {
		const { page, frame } = await open();
		await page.evaluate(() =>
			(window as unknown as { startSession: (s: string, n: string) => void }).startSession(
				"sess_bbbbbbbbbbbbbbbb",
				"0123456789abcdef0123456789abcdef",
			),
		);
		await expect.poll(async () => (await log(page))[0]?.type).toBe("ready");
		await page.evaluate((m) => (window as unknown as { send: (m: unknown) => void }).send(m), {
			type: "render",
			session: "sess_bbbbbbbbbbbbbbbb",
			seq: 1,
			previewRevision: "4",
			puckType: "Hero",
			module: { digest: digest("other"), text: moduleText },
			styles: [],
			props: {},
		});
		await expect.poll(async () => (await log(page))[1]?.code).toBe("MODULE_REJECTED");
		expect(await frame.$("#preview-title")).toBeNull();
		await page.evaluate((m) => (window as unknown as { send: (m: unknown) => void }).send(m), {
			type: "render",
			session: "sess_bbbbbbbbbbbbbbbb",
			seq: 5,
			previewRevision: "4",
			puckType: "Hero",
			module: { digest: digest(moduleText), text: moduleText },
			styles: [],
			props: {},
		});
		await expect.poll(async () => (await log(page))[2]?.code).toBe("PROTOCOL_VIOLATION");
		expect(await status(frame)).toMatch(/^closed:/);
		await page.close();
	});

	it("closes the session on a second bootstrap", async () => {
		const { page, frame } = await open();
		await page.evaluate(() =>
			(window as unknown as { startSession: (s: string, n: string) => void }).startSession(
				"sess_cccccccccccccccc",
				"0123456789abcdef0123456789abcdef",
			),
		);
		await expect.poll(async () => (await log(page))[0]?.type).toBe("ready");
		await page.evaluate(() =>
			(window as unknown as { rebootstrap: (s: string, n: string) => void }).rebootstrap(
				"sess_dddddddddddddddd",
				"0123456789abcdef0123456789abcdef",
			),
		);
		await expect.poll(() => status(frame)).toBe("closed:repeated bootstrap");
		await page.close();
	});
});
