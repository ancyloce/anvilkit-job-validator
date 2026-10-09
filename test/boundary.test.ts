import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { contractsDir } from "../src/contracts.js";
import { packageRoot, rootGate } from "./helpers.js";

// The validator's step boundary under the Job's real identities (VAL-01,
// VAL-05, AC1 and AC6 of P0.8), root only: test/boundary-probe.ts runs the
// chain with the build, the SSR render child and the browser host as UID
// 10001 and the SSR harness as UID 10003, inside a fresh PID namespace in
// which it is not PID 1 (the codegen team's topology: orphans are not
// reparented to the trusted process) and a private mount namespace that
// binds this package, this Node and the Playwright browsers under /tmp,
// where the step identities can reach them. Every process of the step UIDs
// it kills belongs to that PID namespace alone.
const gate = rootGate(["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/mount", "/usr/bin/setsid"]);
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), ".cache", "ms-playwright");

let stage: string | undefined;
afterAll(() => {
	if (!stage) return;
	// The bind mounts lived in the probe's private mount namespace only; the
	// mount points must be empty here before anything is removed.
	for (const m of ["validator", "node", "pw"]) {
		const p = path.join(stage, m);
		if (existsSync(p) && readdirSync(p).length)
			throw new Error(`${p} is not an empty mount point; not removing ${stage}`);
	}
	rmSync(stage, { recursive: true, force: true });
});

interface StopSeen {
	reason: string;
	confirmed: boolean;
	signaled: number;
}
interface RunSeen {
	verdict: string;
	failureCode?: string;
	complete: boolean;
	ssrCheck: { status: string; detail?: string } | null;
	ssrStop?: StopSeen;
	harnessStop?: StopSeen;
	harnessUid?: number;
	planted: number;
	detached?: { pid: number; alive: boolean };
}

describe.skipIf(gate.skip)(
	"the step boundary under the Job's identities (UID 10001 / 10003, trusted process not PID 1)",
	() => {
		it("never certifies the VAL-01 reproductions, stops a detached SSR process before reading, and certifies the fixed Hero", () => {
			gate.assert();
			stage = mkdtempSync("/tmp/anvilkit-boundary-");
			chmodSync(stage, 0o755);
			for (const m of ["validator", "node", "pw", "scratch"]) mkdirSync(path.join(stage, m), { mode: 0o755 });
			chmodSync(path.join(stage, "scratch"), 0o755);
			const script = [
				"set -e",
				'mount --bind "$1" "$2/validator"',
				'mount --bind "$3" "$2/node"',
				'mount --bind "$4" "$2/pw"',
				'cd "$2/validator"',
				'"$2/node/bin/node" --import tsx test/boundary-probe.ts "$2/scratch"',
				"exit $?",
			].join("\n");
			const run = spawnSync(
				"unshare",
				[
					"--pid",
					"--fork",
					"--mount",
					"--propagation",
					"private",
					"--mount-proc",
					"--",
					"/bin/sh",
					"-c",
					script,
					"sh",
					packageRoot,
					stage,
					path.dirname(path.dirname(process.execPath)),
					browsers,
				],
				{
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						HOME: homedir(),
						PLAYWRIGHT_BROWSERS_PATH: path.join(stage, "pw"),
						ANVILKIT_VALIDATOR_CONTRACTS_DIR: contractsDir(),
					},
					encoding: "utf8",
					timeout: 170_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			expect(run.status, run.stderr.slice(-4000)).toBe(0);
			const out = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as {
				pid: number;
				uid: number;
				build: { confirmed: boolean; identity: string };
				throw: RunSeen;
				frame: RunSeen;
				plant: RunSeen;
				detach: RunSeen;
				full: RunSeen & {
					browserStop?: StopSeen;
					chromiumSandbox?: { enabled: boolean; reason?: string };
					failed: string[];
				};
				survivors: unknown[];
			};
			// The trusted process is root and not PID 1 of its namespace.
			expect(out.uid).toBe(0);
			expect(out.pid).toBeGreaterThan(1);
			expect(out.build).toEqual({ confirmed: true, identity: "setpriv" });
			// AC1: a throwing render that writes passing reports wherever UID 10001
			// can (and, in "frame", a forged frame on its own descriptors; in
			// "plant", FIFOs and symbolic links at the report paths) is never
			// certified; the harness that judged it ran as UID 10003.
			for (const mode of ["throw", "frame", "plant"] as const) {
				const r = out[mode];
				expect(r.failureCode, mode).toBe("CANDIDATE_TEST_FAILED");
				expect(r.verdict, mode).toBe("repairable");
				expect(r.complete, mode).toBe(false);
				expect(r.ssrCheck?.status, mode).toBe("fail");
				expect(r.ssrStop?.confirmed, mode).toBe(true);
				expect(r.harnessStop?.confirmed, mode).toBe(true);
				expect(r.harnessUid, mode).toBe(10003);
				expect(r.planted, mode).toBeGreaterThan(0);
			}
			expect(out.frame.ssrCheck?.detail).toMatch(/lacks the value the observer chose/);
			// AC6: the detached sleeper the SSR step left (new session, parent gone)
			// was found by its UID and killed before the render was judged.
			expect(out.detach.ssrCheck?.status).toBe("pass");
			expect(out.detach.ssrStop?.confirmed).toBe(true);
			expect(out.detach.ssrStop?.signaled).toBeGreaterThanOrEqual(1);
			expect(out.detach.detached?.pid).toBeGreaterThan(0);
			expect(out.detach.detached?.alive).toBe(false);
			// The fixed Hero still certifies with both host checks under the real identities.
			expect(out.full.failed).toEqual([]);
			expect(out.full.verdict).toBe("certified");
			expect(out.full.complete).toBe(true);
			expect(out.full.harnessUid).toBe(10003);
			expect(out.full.browserStop?.confirmed).toBe(true);
			expect(typeof out.full.chromiumSandbox?.enabled).toBe("boolean");
			if (!out.full.chromiumSandbox?.enabled) expect(out.full.chromiumSandbox?.reason).toBeTruthy();
			expect(out.survivors).toEqual([]);
		});
	},
);
