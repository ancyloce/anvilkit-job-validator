// Protected observer script (DD-04 §3): run by the browser worker
// (src/host-browser-worker.ts) in a CDP isolated world of the host page —
// the same document, a JavaScript realm of its own whose built-ins the
// page's scripts never touched. It reads the rendered tree and, for each
// declared stylesheet, establishes that the sheet is enabled, that its
// loaded rules serialize as a fresh parse of the shipped bytes does, that
// its rules match the rendered tree AND actually take effect in the browser's
// computed style, and that the resources the validator parsed from it load.
// The resource list and the shipped bytes are handed over by the validator
// (parsed with css-tree); the observer never scans CSS text itself, so a
// downloaded file or a matching selector is never on its own taken as proof
// that a style is in force. Plain JavaScript on purpose: it is sent to the
// browser as source, pinned by digest in the validator profile and rechecked
// before and after every run.
// biome-ignore lint/correctness/noUnusedVariables: sent to the browser as source, not called here
async function observe(args) {
	const root = document.getElementById("root");
	if (!root) throw new Error("no #root element");
	const text = root.textContent ?? "";
	const textPresent = {};
	for (const t of args.expectedTexts) textPresent[t] = text.includes(t);
	const declared = new Set(args.cssUrls);
	const stylesheets = [];
	const undeclaredStylesheets = [];
	const loads = async (url) => {
		if (/\.(svg|png|jpe?g|webp|gif)$/i.test(new URL(url).pathname)) {
			const img = new Image();
			img.src = url;
			try {
				await img.decode();
				return true;
			} catch {
				return false;
			}
		}
		try {
			return (await fetch(url, { cache: "no-store" })).ok;
		} catch {
			return false;
		}
	};
	// Whether the browser's computed style for `el` reflects the declaration
	// `prop: value` — the test of whether a rule takes effect, not merely that
	// it exists and its selector matches. Shorthands are expanded by the
	// browser's own CSSOM (a detached element's inline style), so no CSS
	// knowledge lives here. A declaration is in effect only when every longhand
	// it expands to has, on the element, the computed value the browser derives
	// from the declaration AND at least one of those longhands actually differs
	// from the element's default (`baseline`, a bare element of the same tag):
	// a declaration that merely restates a default (border: 0, margin: 0) proves
	// nothing, and disabling the sheet drops the computed value back to the
	// default so no non-default declaration matches any more.
	const probe = document.createElement("div");
	const declarationInEffect = (el, baseline, prop, value) => {
		probe.style.cssText = "";
		try {
			probe.style.setProperty(prop, value);
		} catch {
			return false;
		}
		const longhands = probe.style.length ? Array.from(probe.style) : [prop];
		const computed = getComputedStyle(el);
		let changed = false;
		for (const lh of longhands) {
			const want = probe.style.getPropertyValue(lh);
			if (want === "" || computed.getPropertyValue(lh) !== want) return false;
			if (baseline.getPropertyValue(lh) !== want) changed = true;
		}
		return changed;
	};
	for (const sheet of Array.from(document.styleSheets)) {
		if (!sheet.href) {
			undeclaredStylesheets.push("<style>");
			continue;
		}
		const href = new URL(sheet.href).pathname;
		if (!declared.has(href)) {
			undeclaredStylesheets.push(href);
			continue;
		}
		const entry = {
			href,
			disabled: sheet.disabled === true,
			rules: 0,
			matchedRules: 0,
			effectiveRules: 0,
			sameAsShipped: false,
			imports: [],
			resources: [],
		};
		const loaded = [];
		for (const rule of Array.from(sheet.cssRules)) {
			if (rule.type === CSSRule.IMPORT_RULE) {
				entry.imports.push({ href: new URL(rule.href, sheet.href).pathname, loaded: rule.styleSheet !== null });
				continue;
			}
			loaded.push(rule.cssText);
			if (rule.type !== CSSRule.STYLE_RULE) continue;
			entry.rules++;
			let el = null;
			try {
				el = root.matches(rule.selectorText) ? root : root.querySelector(rule.selectorText);
			} catch {
				el = null;
			}
			if (!el) continue;
			entry.matchedRules++;
			// The rule applies to an element; does it take effect? A declaration
			// of the rule whose non-default value the element's computed style
			// actually shows proves the sheet is enabled and in force, not merely
			// loaded. The baseline is a bare element of the same tag, so an
			// inherited or default value is not mistaken for the rule's effect.
			const baselineEl = document.createElement(el.tagName);
			document.body.appendChild(baselineEl);
			const baseline = getComputedStyle(baselineEl);
			let effective = false;
			for (let i = 0; i < rule.style.length; i++) {
				const prop = rule.style.item(i);
				if (declarationInEffect(el, baseline, prop, rule.style.getPropertyValue(prop))) {
					effective = true;
					break;
				}
			}
			baselineEl.remove();
			if (effective) entry.effectiveRules++;
		}
		const reference = new CSSStyleSheet();
		reference.replaceSync(args.cssText[href] ?? "");
		const expected = Array.from(reference.cssRules).map((r) => r.cssText);
		entry.sameAsShipped = expected.length === loaded.length && expected.every((t, i) => t === loaded[i]);
		// The resources the validator parsed from this stylesheet (url(), src(),
		// image-set() and @import in custom properties and var() fallbacks
		// alike); the observer only confirms each loads in the browser.
		for (const rawUrl of args.cssResources[href] ?? []) {
			const abs = new URL(rawUrl, sheet.href);
			entry.resources.push({ url: abs.pathname, loaded: await loads(abs.toString()) });
		}
		stylesheets.push(entry);
	}
	return {
		elementCount: root.querySelectorAll("*").length,
		textLength: text.length,
		textPresent,
		stylesheets,
		undeclaredStylesheets,
	};
}
