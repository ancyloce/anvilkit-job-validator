// The browser step (DD-04 §3), a child process of the observer: one
// headless Chromium page (Playwright) whose every request the worker
// answers itself through Playwright's request interception — the protected
// host page and bundles under /host, the candidate's staged package under
// /candidate and the session document, on a synthetic origin that resolves
// nowhere. No socket is involved: the container that runs the candidate
// steps admits AF_UNIX sockets only (the P09 candidate seccomp profile,
// DD-03 §5), the browser and the worker talk over pipes, and a request the
// worker does not answer is aborted and logged. Everything decisive is
// observed from outside the page's main world, which the candidate module
// shares with the host script and can rewrite at will: the DOM and the
// CSSOM are read in an isolated world (Playwright's utility world for
// locators, a CDP isolated world for the observer's own script; same
// document, separate JavaScript realm), the requests come from Playwright's
// own network events and the worker's route log, the observer's script is
// the protected fixtures/host/browser/observer.js, input is real, and the
// re-render with props of the worker's choosing goes through a handle to
// the host's frozen control object captured before the candidate module is
// imported (the session, and with it the import, is answered only after
// that). The page's own report is carried as data for the record; nothing
// is decided from it. The worker writes its observations to the result
// file and exits; the observer decides from them and from its own static
// checks.
//
//   node host-browser-worker <session.json> <result.json>

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type JSHandle, type Route } from "playwright";

/** The synthetic origin of the host page: never resolved, every request answered by this worker. */
export const hostOrigin = "http://anvilkit-host.invalid";

export interface BrowserSession {
	htmlPath: string;
	/** The protected observer script (fixtures/host/browser/observer.js), sent to the isolated world as source. */
	observerPath: string;
	hostDir: string;
	candidateDir: string;
	moduleUrl: string;
	cssUrls: string[];
	/** The shipped stylesheet bytes by URL, for the CSSOM comparison in the isolated world. */
	cssText: Record<string, string>;
	/** The resources each stylesheet references (parsed by the validator), by URL; the isolated world only confirms each loads. */
	cssResources: Record<string, string[]>;
	puckType: string;
	fieldNames: string[];
	defaultProps: Record<string, unknown>;
	expectedTexts: string[];
	/** A text field to re-render with a value of the worker's choosing (null when the component declares none). */
	nonceField: string | null;
	/** The fixed-fixture interaction contract: a click must advance this DOM attribute by `increment` (null: none required). */
	interaction: { counterAttribute: string; increment: number } | null;
	timeoutMs: number;
}

/** One stylesheet as the isolated world found it in the document. */
export interface ObservedStylesheet {
	href: string;
	/** Whether the sheet is disabled in the document (a disabled sheet loads but never takes effect). */
	disabled: boolean;
	rules: number;
	matchedRules: number;
	/** Matched rules whose declared values the element's computed style actually shows (the sheet in force). */
	effectiveRules: number;
	/** The loaded rules (imports aside) serialize as the shipped bytes do when parsed by this browser. */
	sameAsShipped: boolean;
	imports: Array<{ href: string; loaded: boolean }>;
	/** The resources the validator parsed from the stylesheet, and whether each loaded in the browser. */
	resources: Array<{ url: string; loaded: boolean }>;
}

/** What the worker established through Playwright, outside the page's main world. */
export interface BrowserObservation {
	elementCount: number;
	textLength: number;
	textPresent: Record<string, boolean>;
	stylesheets: ObservedStylesheet[];
	/** Stylesheets in the document that are not the declared ones ("<style>" for inline sheets). */
	undeclaredStylesheets: string[];
	/** The re-render with the worker's value through the captured control: which field, and whether the DOM showed it. */
	nonce: { field: string | null; rendered: boolean };
	/**
	 * The real click and its outcome: how many buttons, whether the click landed,
	 * and — when the profile names a counter attribute — whether that attribute
	 * advanced by the required amount (its before/after values), the defined
	 * click-count transition of the fixed Hero.
	 */
	interaction: {
		buttons: number;
		clicked: boolean;
		changed: boolean;
		counterAttribute: string | null;
		before: string | null;
		after: string | null;
		transitioned: boolean;
	};
	pageErrors: string[];
}

export interface BrowserWorkerResult {
	ok: boolean;
	kind?: "candidate" | "infrastructure" | "timeout";
	error?: string;
	observed?: BrowserObservation;
	/** The page's own report from the main world: informational, candidate-controlled, never decisive. */
	page?: unknown;
	consoleErrors: string[];
	/** The worker's route log: what the page requested on the host origin and what was answered (404: nothing). */
	requests: Array<{ path: string; status: number }>;
	/** Playwright's own request log: every request the page made, with the browser's resource type. */
	pageRequests: Array<{ url: string; resourceType: string; status: number | null; failure?: string }>;
	browser?: string;
}

const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
};

function safeJoin(root: string, rel: string): string | undefined {
	if (rel.includes("\0") || rel.split("/").some((s) => s === "..")) return undefined;
	const abs = path.join(root, rel);
	if (!abs.startsWith(`${root}${path.sep}`) && abs !== root) return undefined;
	return abs;
}

interface ObserveArgs {
	cssUrls: string[];
	cssText: Record<string, string>;
	cssResources: Record<string, string[]>;
	expectedTexts: string[];
}

async function main(): Promise<void> {
	const [sessionPath, resultPath] = process.argv.slice(2);
	if (!sessionPath || !resultPath) throw new Error("usage: host-browser-worker <session.json> <result.json>");
	const session = JSON.parse(readFileSync(sessionPath, "utf8")) as BrowserSession;
	const result: BrowserWorkerResult = { ok: false, consoleErrors: [], requests: [], pageRequests: [] };
	const write = () => writeFileSync(resultPath, JSON.stringify(result));
	const html = readFileSync(session.htmlPath);
	// The session is answered only once the worker holds its handle on the
	// host's control object; until then the request stays paused.
	let releaseSession: () => void = () => {};
	const sessionReleased = new Promise<void>((resolve) => {
		releaseSession = resolve;
	});
	const sessionBody = JSON.stringify({
		moduleUrl: session.moduleUrl,
		cssUrls: session.cssUrls,
		puckType: session.puckType,
		fieldNames: session.fieldNames,
		defaultProps: session.defaultProps,
		expectedTexts: session.expectedTexts,
	});
	const answer = async (route: Route): Promise<void> => {
		const url = new URL(route.request().url());
		if (url.origin !== hostOrigin) {
			await route.abort("blockedbyclient");
			return;
		}
		const p = url.pathname;
		let body: Buffer | string | undefined;
		let type = "application/octet-stream";
		if (p === "/") {
			body = html;
			type = types[".html"] as string;
		} else if (p === "/session.json") {
			await sessionReleased;
			body = sessionBody;
			type = types[".json"] as string;
		} else {
			const file = p.startsWith("/host/")
				? safeJoin(session.hostDir, p.slice("/host/".length))
				: p.startsWith("/candidate/")
					? safeJoin(session.candidateDir, p.slice("/candidate/".length))
					: undefined;
			if (file && existsSync(file) && statSync(file).isFile()) {
				body = readFileSync(file);
				type = types[path.extname(file)] ?? "application/octet-stream";
			}
		}
		const status = body !== undefined ? 200 : 404;
		result.requests.push({ path: p, status });
		await route.fulfill({
			status,
			headers: { "content-type": type, "cache-control": "no-store" },
			body: body ?? "",
		});
	};
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	const pageErrors: string[] = [];
	try {
		browser = await chromium.launch({ headless: true, chromiumSandbox: false });
		result.browser = browser.version();
		// No service worker (it could answer the page's later requests) and
		// nothing but this worker's answers: any other origin is refused.
		const context = await browser.newContext({ javaScriptEnabled: true, offline: false, serviceWorkers: "block" });
		await context.route("**/*", answer);
		const page = await context.newPage();
		page.on("console", (m) => {
			if (m.type() === "error") result.consoleErrors.push(m.text().slice(0, 500));
		});
		page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 500)));
		page.on("requestfinished", async (req) => {
			const res = await req.response().catch(() => null);
			result.pageRequests.push({ url: req.url(), resourceType: req.resourceType(), status: res?.status() ?? null });
		});
		page.on("requestfailed", (req) => {
			result.pageRequests.push({
				url: req.url(),
				resourceType: req.resourceType(),
				status: null,
				failure: req.failure()?.errorText ?? "failed",
			});
		});
		await page.goto(`${hostOrigin}/`, { waitUntil: "load", timeout: session.timeoutMs });

		// The host's control object, captured before the candidate module can
		// run: a frozen object; its rerender closes over the host's bindings.
		type HostWindow = Window & {
			__anvilkitHostControl?: { rerender: (props: Record<string, unknown>) => boolean };
			__anvilkitHost?: { done: boolean; result: unknown };
		};
		const control = (await page.evaluateHandle(() => (window as HostWindow).__anvilkitHostControl)) as JSHandle<{
			rerender: (props: Record<string, unknown>) => boolean;
		}>;
		const controlShape = await control.evaluate((c) => ({
			frozen: Object.isFrozen(c),
			rerender: typeof c?.rerender === "function",
		}));
		if (!controlShape.frozen || !controlShape.rerender) {
			result.kind = "infrastructure";
			result.error = "the host page exposed no frozen control object before the session";
			return;
		}
		releaseSession();

		// The page's completion flag is a timing hint from the main world;
		// what follows is observed regardless of what the page reported.
		let finished = true;
		try {
			await page.waitForFunction(() => (window as HostWindow).__anvilkitHost?.done === true, undefined, {
				timeout: session.timeoutMs,
			});
		} catch {
			finished = false;
		}
		result.page = await page
			.evaluate(() => JSON.stringify((window as HostWindow).__anvilkitHost?.result ?? null).slice(0, 65536))
			.then((s) => JSON.parse(s) as unknown)
			.catch((err) => ({ unreadable: String((err as Error).message) }));
		if (!finished) {
			result.kind = "timeout";
			result.error = "the host page did not finish within the bound";
			return;
		}

		// The observer's own read of the document in an isolated world.
		const cdp = await context.newCDPSession(page);
		const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
		const { executionContextId } = (await cdp.send("Page.createIsolatedWorld", {
			frameId: frameTree.frame.id,
			worldName: "anvilkit-observer",
			grantUniveralAccess: false,
		})) as { executionContextId: number };
		const observeArgs: ObserveArgs = {
			cssUrls: session.cssUrls,
			cssText: session.cssText,
			cssResources: session.cssResources,
			expectedTexts: session.expectedTexts,
		};
		const observed = (await cdp.send("Runtime.callFunctionOn", {
			functionDeclaration: readFileSync(session.observerPath, "utf8"),
			arguments: [{ value: observeArgs }],
			executionContextId,
			returnByValue: true,
			awaitPromise: true,
		})) as { result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
		if (observed.exceptionDetails) {
			result.kind = "candidate";
			result.error = `observation failed: ${observed.exceptionDetails.exception?.description ?? observed.exceptionDetails.text ?? "unknown"}`;
			return;
		}
		const dom = observed.result.value as Omit<BrowserObservation, "nonce" | "interaction" | "pageErrors">;

		// A re-render through the host's React with a value only this worker
		// knows: a component that renders shows it; nothing else can.
		const rootLocator = page.locator("#root");
		const nonce: BrowserObservation["nonce"] = { field: session.nonceField, rendered: false };
		if (session.nonceField) {
			const value = `anvilkit-${randomBytes(8).toString("hex")}`;
			try {
				await control.evaluate((c, [field, v]) => c.rerender({ [field as string]: v }), [session.nonceField, value]);
				await rootLocator.filter({ hasText: value }).waitFor({ state: "attached", timeout: 10_000 });
				nonce.rendered = ((await rootLocator.textContent()) ?? "").includes(value);
			} catch {
				nonce.rendered = false;
			}
		}

		// Interaction: real input through the browser. When the profile names a
		// counter attribute (the fixed Hero's `data-clicks`), the worker verifies
		// the defined click-count transition — the attribute advancing by the
		// required amount — by waiting through Playwright's own locator for the
		// element that carries the incremented value, never a fixed sleep and
		// never the page's main world. An empty onClick, or one that does not
		// make the transition, leaves the attribute unchanged and the wait times
		// out. Without a counter attribute nothing about the click is required,
		// so this is not a rule that every component's click must change the DOM.
		const spec = session.interaction;
		const selector = spec ? `#root button[${spec.counterAttribute}]` : "#root button";
		const buttons = page.locator(selector);
		const interaction: BrowserObservation["interaction"] = {
			buttons: await buttons.count(),
			clicked: false,
			changed: false,
			counterAttribute: spec?.counterAttribute ?? null,
			before: null,
			after: null,
			transitioned: false,
		};
		if (interaction.buttons > 0) {
			const target = buttons.first();
			const beforeHtml = await rootLocator.innerHTML();
			if (spec) interaction.before = await target.getAttribute(spec.counterAttribute);
			try {
				await target.click({ timeout: 10_000 });
				interaction.clicked = true;
				if (spec) {
					const from = Number(interaction.before);
					const want = Number.isFinite(from) ? String(from + spec.increment) : null;
					if (want !== null) {
						// Wait through Playwright for the button to carry the advanced
						// value; the attribute read is Playwright's (the utility world),
						// not anything the page's main world reported.
						try {
							await page
								.locator(`#root button[${spec.counterAttribute}="${want}"]`)
								.first()
								.waitFor({ state: "attached", timeout: 10_000 });
						} catch {
							// the transition did not happen within the bound
						}
					}
					interaction.after = await target.getAttribute(spec.counterAttribute);
					interaction.transitioned = want !== null && interaction.after === want;
				}
				// Recorded as data beside the outcome; the verdict is the transition.
				interaction.changed = (await rootLocator.innerHTML()) !== beforeHtml;
			} catch {
				interaction.clicked = false;
			}
		}
		result.observed = { ...dom, nonce, interaction, pageErrors: [...pageErrors] };
		result.ok = true;
	} catch (err) {
		result.kind = "infrastructure";
		result.error = String((err as Error).message ?? err);
	} finally {
		await browser?.close().catch(() => {});
		write();
	}
	process.exitCode = result.ok ? 0 : 1;
}

main()
	.then(
		() => undefined,
		(err) => {
			const resultPath = process.argv[3];
			if (resultPath) {
				writeFileSync(
					resultPath,
					JSON.stringify({
						ok: false,
						kind: "infrastructure",
						error: String((err as Error).stack ?? err),
						consoleErrors: [],
						requests: [],
						pageRequests: [],
					}),
				);
			}
			process.exit(2);
		},
	)
	.then(() => process.exit(process.exitCode ?? 0));
