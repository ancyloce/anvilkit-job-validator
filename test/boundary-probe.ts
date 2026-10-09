// The probe of boundary.test.ts (root only, not a test file itself): the
// validator chain under the Job's real step identities — the build, the SSR
// render child and the browser host as UID/GID 10001, the SSR harness as
// UID/GID 10003, through setpriv — run in a fresh PID and mount namespace in
// which this trusted process is NOT PID 1 (a shell is, as the codegen team's
// supervisor is in its container), so no orphan is reparented to it. It
// prints one JSON line with what it observed; the test asserts on it.
//
//   node --import tsx test/boundary-probe.ts <scratch root>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildComponent } from "../src/build.js";
import { identityProcesses, scanProcesses, setprivIdentity } from "../src/isolation.js";
import { loadProfiles, verifyToolchain } from "../src/profiles.js";
import { readSource } from "../src/source.js";
import { type Certification, certify } from "../src/validate.js";
import { forgedFiles, forgingModule, heroSource, mutatedBuild } from "./helpers.js";

const scratchRoot = process.argv[2];
if (!scratchRoot) throw new Error("usage: boundary-probe <scratch root>");
const identity = setprivIdentity();
const stepUids = [10001, 10003];
const profiles = loadProfiles();
const toolchain = verifyToolchain(profiles);
const source = readSource(heroSource, {
	sourceRevision: "1",
	profile: profiles.build,
	limits: profiles.validator.limits,
});
let n = 0;
const fresh = () => path.join(scratchRoot, `run-${n++}`);
const build = await buildComponent(source, profiles, fresh(), { identity });

const summary = (cert: Certification) => {
	const ssrCheck = cert.checks.find((c) => c.name === "ssr-render");
	return {
		verdict: cert.verdict,
		failureCode: cert.failureCode,
		complete: cert.complete,
		ssrCheck: ssrCheck ? { status: ssrCheck.status, detail: ssrCheck.detail } : null,
		ssrStop: cert.steps.ssr?.stop,
		harnessStop: cert.steps.ssrHarness?.stop,
		harnessUid: (cert.host.ssr as { uid?: number } | undefined)?.uid,
	};
};

// A detached process left by the SSR step: the fixed Hero's own module,
// which at import starts a sleeper in a new session whose parent exits at
// once (double fork and setsid) and records its pid in the step's HOME;
// the module then renders normally.
const detach = `
if (typeof process !== "undefined" && typeof window === "undefined") {
	process.getBuiltinModule("node:child_process").spawnSync("/bin/sh", ["-c", "(setsid sleep 600 & echo $! > \\"$HOME/detached.pid\\")"], { stdio: "ignore" });
}
`;

const out: Record<string, unknown> = { pid: process.pid, ppid: process.ppid, uid: process.getuid?.() };
out.build = { confirmed: build.step.stop.confirmed, identity: build.step.identity };
for (const mode of ["throw", "frame", "plant", "detach"] as const) {
	const b = await mutatedBuild(build, fresh(), (pkg) => {
		const file = path.join(pkg, "dist", "index.js");
		const text = mode === "detach" ? `${readFileSync(file, "utf8")}\n${detach}` : forgingModule(mode);
		writeFileSync(file, text);
	});
	const cert = await certify({
		source,
		build: b,
		profiles,
		toolchain,
		identity,
		hostChecks: { ssr: true, browser: false },
	});
	const entry: Record<string, unknown> = summary(cert);
	entry.planted = forgedFiles(b.workDir).length;
	if (mode === "detach") {
		const scratch = readdirSync(b.workDir).find((d) => d.startsWith("scratch-ssr-"));
		const pid = scratch ? Number(readFileSync(path.join(b.workDir, scratch, "detached.pid"), "utf8")) : 0;
		const p = scanProcesses().get(pid);
		entry.detached = { pid, alive: p !== undefined && p.state !== "Z" && p.state !== "X" };
	}
	out[mode] = entry;
}
// The fixed Hero, certified with both host checks under the real identities.
const full = await certify({ source, build, profiles, toolchain, identity, hostChecks: { ssr: true, browser: true } });
out.full = {
	...summary(full),
	browserStop: full.steps.browser?.stop,
	chromiumSandbox: (full.host.browser as { chromiumSandbox?: unknown } | undefined)?.chromiumSandbox,
	failed: full.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`),
};
out.survivors = identityProcesses(scanProcesses(), stepUids).map((p) => [p.pid, p.uid, p.state]);
console.log(JSON.stringify(out));
