// Protected host script (compiled to /host/host.js by src/host-bundles.ts).
// It reads the session the observer's worker serves, loads the declared
// stylesheets, imports the candidate module by URL through the page's
// import map and mounts it through Puck's Render with the host's React.
// It is the host side of the check, not its evidence: the observer's worker
// establishes what the page shows through Playwright (an isolated world for
// the DOM and the CSSOM, its own request log, real input) and the
// candidate, which shares this page's main world, can neither reach nor
// forge that. What this script reports on window is informational only.
//
// The one thing the worker takes from this world is a handle it captures
// before the candidate module is imported: the frozen control object below,
// whose rerender drives the mounted component through the host's React
// with props the worker chooses. The candidate cannot replace the captured
// object, its function, or the module bindings they close over.
import { type ComponentConfig, Render } from "@puckeditor/core";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

interface Session {
	moduleUrl: string;
	cssUrls: string[];
	puckType: string;
	fieldNames: string[];
	defaultProps: Record<string, unknown>;
	expectedTexts: string[];
}

interface HostReport {
	ok: boolean;
	errors: string[];
	exports?: string[];
	fields?: string[];
	renderers: string[];
	resolved: Record<string, string>;
	rootHtmlLength?: number;
	elementCount?: number;
}

declare global {
	interface Window {
		__anvilkitHost?: { done: boolean; result: HostReport };
		__anvilkitHostControl?: HostControl;
		__anvilkitRenderers: string[];
	}
}

interface HostControl {
	readonly version: 1;
	/** Renders the mounted component again through Puck's Render with these props over the defaults. */
	readonly rerender: (props: Record<string, unknown>) => boolean;
}

const report: HostReport = { ok: false, errors: [], renderers: [], resolved: {} };
let mounted: { root: Root; config: ComponentConfig; puckType: string; props: Record<string, unknown> } | undefined;

function renderThroughPuck(props: Record<string, unknown>): void {
	if (!mounted) throw new Error("nothing is mounted");
	const { root, config, puckType } = mounted;
	flushSync(() => {
		root.render(
			createElement(Render, {
				config: { components: { [puckType]: config } } as never,
				data: {
					content: [{ type: puckType, props: { id: "host-1", ...props } }],
					root: { props: {} },
				} as never,
			}),
		);
	});
}

const control: HostControl = Object.freeze({
	version: 1,
	rerender(props: Record<string, unknown>): boolean {
		if (!mounted) throw new Error("nothing is mounted");
		renderThroughPuck({ ...mounted.props, ...props });
		return true;
	},
});
Object.defineProperty(window, "__anvilkitHostControl", {
	value: control,
	writable: false,
	configurable: false,
	enumerable: false,
});

function finish(): void {
	window.__anvilkitHost = { done: true, result: report };
	document.title = report.ok ? "anvilkit host: ok" : "anvilkit host: failed";
}

async function loadStylesheet(href: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		link.onload = () => resolve();
		link.onerror = () => reject(new Error(`stylesheet ${href} did not load`));
		document.head.appendChild(link);
	});
}

async function main(): Promise<void> {
	// The session is served only once the worker holds its handle on the
	// control object; the candidate module is not imported before that.
	const session = (await (await fetch("/session.json")).json()) as Session;
	for (const specifier of ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@puckeditor/core"]) {
		report.resolved[specifier] = new URL(import.meta.resolve(specifier)).pathname;
	}
	for (const href of session.cssUrls) await loadStylesheet(href);
	const mod = (await import(/* @vite-ignore */ session.moduleUrl)) as Record<string, unknown>;
	report.exports = Object.keys(mod).sort();
	const config = mod.default as ComponentConfig | undefined;
	if (!config || typeof config !== "object" || typeof config.render !== "function" || !config.fields) {
		throw new Error("the default export is not a Puck component config");
	}
	report.fields = Object.keys(config.fields).sort();
	const want = [...session.fieldNames].sort();
	if (report.fields.join("\n") !== want.join("\n"))
		throw new Error(`fields [${report.fields.join(", ")}] differ from the declared [${want.join(", ")}]`);
	const props = { ...(config.defaultProps ?? {}), ...session.defaultProps };
	const container = document.getElementById("root") as HTMLElement;
	mounted = { root: createRoot(container), config, puckType: session.puckType, props };
	renderThroughPuck(props);
	await new Promise((r) => requestAnimationFrame(() => r(undefined)));
	report.renderers = [...window.__anvilkitRenderers];
	report.rootHtmlLength = container.innerHTML.length;
	report.elementCount = container.querySelectorAll("*").length;
	if (report.elementCount === 0) throw new Error("the component rendered no element");
	report.ok = true;
}

main()
	.catch((err) => {
		report.errors.push(String(err instanceof Error ? `${err.message}` : err));
	})
	.finally(finish);
