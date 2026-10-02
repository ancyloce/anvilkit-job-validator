// Preview frame of anvilkit-preview-v1 (DD-04 §5, DD-05 §4; contracts
// components/component.schema.json previewBootstrap/previewMessage),
// compiled to /frame.js by src/preview-origin.ts. It runs on the separate
// preview origin inside Studio's sandboxed iframe (allow-scripts, never
// allow-same-origin), with the build profile's own Host ABI runtime
// (host-abi-dev-v1: one React, one ReactDOM, one Puck through the page's
// import map). Unapproved source runs only here; the Studio realm never
// imports it.
//
// Exactly one bootstrap is accepted, only from window.parent at the
// configured parent origin, and it binds one MessagePort; any other window
// message afterwards closes the session. On the port every message is typed,
// bounded and sequenced (seq starts at 1 and increases by exactly 1 per
// direction); the module and stylesheet texts must hash to the digests the
// render names before anything is imported. Any violation closes the
// session: a new session needs a new frame.
import { type ComponentConfig, Render } from "@puckeditor/core";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

const PROTOCOL = "anvilkit-preview-v1";
const HOST_PROFILE = "host-abi-dev-v1";
const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
const SESSION = /^[A-Za-z0-9_-]{16,64}$/;
const NONCE = /^[0-9a-f]{32,64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PUCK_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/;

const parentOrigin = document.querySelector<HTMLMetaElement>('meta[name="anvilkit-parent-origin"]')?.content ?? "";

type Json = Record<string, unknown>;

let port: MessagePort | undefined;
let session = "";
let inSeq = 0;
let outSeq = 0;
let closed = false;
let root: Root | undefined;
let styleUrls: string[] = [];
let moduleUrl: string | undefined;

function setStatus(status: string): void {
	document.documentElement.dataset.previewStatus = status;
}

function send(message: Json): void {
	if (!port || closed) return;
	outSeq += 1;
	port.postMessage({ ...message, session, seq: outSeq });
}

function release(): void {
	for (const u of styleUrls) URL.revokeObjectURL(u);
	styleUrls = [];
	for (const el of Array.from(document.querySelectorAll("link[data-preview-style]"))) el.remove();
	if (moduleUrl) URL.revokeObjectURL(moduleUrl);
	moduleUrl = undefined;
}

function close(reason: string): void {
	if (closed) return;
	closed = true;
	setStatus(`closed:${reason}`);
	try {
		root?.unmount();
	} catch {
		// the session ends either way
	}
	release();
	port?.close();
}

function violation(reason: string): void {
	send({ type: "error", code: "PROTOCOL_VIOLATION" });
	close(reason);
}

async function digestOf(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return `sha256:${Array.from(sum, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function loadStyle(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		link.dataset.previewStyle = "";
		link.onload = () => resolve();
		link.onerror = () => reject(new Error("stylesheet did not load"));
		document.head.appendChild(link);
	});
}

function isText(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length <= max;
}

async function render(msg: Json): Promise<void> {
	const renderSeq = msg.seq as number;
	const mod = msg.module as Json | undefined;
	const styles = msg.styles as Json[] | undefined;
	if (
		!mod ||
		!DIGEST.test(String(mod.digest)) ||
		!isText(mod.text, 2 * 1024 * 1024) ||
		!Array.isArray(styles) ||
		styles.length > 16 ||
		!PUCK_TYPE.test(String(msg.puckType)) ||
		typeof msg.props !== "object" ||
		msg.props === null ||
		typeof msg.previewRevision !== "string"
	) {
		violation("malformed render");
		return;
	}
	for (const s of styles) {
		if (!DIGEST.test(String(s.digest)) || !isText(s.text, 1024 * 1024) || (await digestOf(s.text)) !== s.digest) {
			send({ type: "error", renderSeq, code: "STYLE_REJECTED" });
			return;
		}
	}
	if ((await digestOf(mod.text)) !== mod.digest) {
		send({ type: "error", renderSeq, code: "MODULE_REJECTED" });
		return;
	}
	release();
	try {
		for (const s of styles) {
			const url = URL.createObjectURL(new Blob([s.text as string], { type: "text/css" }));
			styleUrls.push(url);
			await loadStyle(url);
		}
		moduleUrl = URL.createObjectURL(new Blob([mod.text], { type: "text/javascript" }));
		const loaded = (await import(/* @vite-ignore */ moduleUrl)) as { default?: ComponentConfig };
		const config = loaded.default;
		if (!config || typeof config !== "object" || typeof (config as { render?: unknown }).render !== "function") {
			send({ type: "error", renderSeq, code: "MODULE_REJECTED" });
			return;
		}
		const puckType = String(msg.puckType);
		const defaults = ((config as { defaultProps?: Json }).defaultProps ?? {}) as Json;
		const mount = document.getElementById("root");
		if (!mount) throw new Error("no root");
		root ??= createRoot(mount);
		const current = root;
		flushSync(() => {
			current.render(
				createElement(Render, {
					config: { components: { [puckType]: config } } as never,
					data: { content: [{ type: puckType, props: { ...defaults, ...(msg.props as Json), id: "preview-1" } }], root: { props: {} } } as never,
				}),
			);
		});
		setStatus(`rendered:${msg.previewRevision}`);
		send({ type: "rendered", renderSeq, previewRevision: msg.previewRevision });
	} catch {
		send({ type: "error", renderSeq, code: "RENDER_FAILED" });
	}
}

function onPortMessage(ev: MessageEvent): void {
	if (closed) return;
	const msg = ev.data as Json;
	let size = 0;
	try {
		size = JSON.stringify(msg).length;
	} catch {
		size = Number.POSITIVE_INFINITY;
	}
	if (!msg || typeof msg !== "object" || size > MAX_MESSAGE_CHARS || msg.session !== session || msg.seq !== inSeq + 1) {
		violation("disorder, oversize or foreign session");
		return;
	}
	inSeq += 1;
	if (msg.type === "dispose") {
		close("disposed");
		return;
	}
	if (msg.type !== "render") {
		violation(`unknown type ${String(msg.type)}`);
		return;
	}
	void render(msg);
}

window.addEventListener("message", (ev: MessageEvent) => {
	if (port) {
		// A second bootstrap (or any other window message) ends the session.
		close("repeated bootstrap");
		return;
	}
	const data = ev.data as Json;
	if (
		ev.source !== window.parent ||
		parentOrigin === "" ||
		ev.origin !== parentOrigin ||
		!data ||
		data.type !== "anvilkit.preview.bootstrap" ||
		data.protocol !== PROTOCOL ||
		data.parentOrigin !== parentOrigin ||
		!SESSION.test(String(data.session)) ||
		!NONCE.test(String(data.nonce)) ||
		ev.ports.length !== 1
	) {
		return;
	}
	port = ev.ports[0];
	session = String(data.session);
	port.onmessage = onPortMessage;
	setStatus("ready");
	send({ type: "ready", nonce: data.nonce, hostProfileId: HOST_PROFILE });
});
setStatus("waiting");
