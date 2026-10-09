import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	callerIdentity,
	identityProcesses,
	readStepOutput,
	runStep,
	type StepIdentity,
	scanProcesses,
	stepProcesses,
} from "../src/isolation.js";
import { packageRoot, rootGate } from "./helpers.js";

const scratch: string[] = [];
function dir(prefix: string): string {
	const d = mkdtempSync(path.join("/tmp", prefix));
	scratch.push(d);
	return d;
}
afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

// A step that starts a child of its own (same session, inherits nothing but
// the pipes closed) and reports both pids, then exits or hangs.
const stepScript = (mode: "exit" | "hang", pidFile: string) => `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ leader: process.pid, child: child.pid }));
${mode === "exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
`;

function alive(pid: number): boolean {
	const p = scanProcesses().get(pid);
	return p !== undefined && p.state !== "Z" && p.state !== "X";
}

describe("step stop and confirmation as the caller", () => {
	it("stops the child a leader left behind after a normal exit and confirms it", async () => {
		const d = dir("anvilkit-stop-");
		const pidFile = path.join(d, "pids.json");
		writeFileSync(path.join(d, "step.mjs"), stepScript("exit", pidFile));
		const out = await runStep([process.execPath, path.join(d, "step.mjs")], {
			cwd: d,
			timeoutMs: 20_000,
			identity: callerIdentity(),
		});
		const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { leader: number; child: number };
		expect(out.code).toBe(0);
		expect(out.timedOut).toBe(false);
		expect(out.stop).toEqual({ reason: "exited", confirmed: true, signaled: expect.any(Number) });
		expect(alive(pids.child)).toBe(false);
		expect(alive(pids.leader)).toBe(false);
		expect(stepProcesses(scanProcesses(), { root: process.pid, leader: pids.leader })).toEqual([]);
	});

	it("returns within a bound as unobserved when the stop cannot be established and the leader stays alive", async () => {
		// A step that hangs past its bound, with a stop that never establishes
		// the kill (the setpriv helper failing in the Job): the leader is still
		// alive when settle runs, so the pre-fix `await exited` would hang here.
		// runStep must instead resolve within a defined bound with the stop
		// unconfirmed, so the caller treats the step as OBSERVER_FAILED and
		// reads nothing it left; the Job's own cleanup reclaims the survivor.
		const d = dir("anvilkit-stop-");
		const pidFile = path.join(d, "pids.json");
		writeFileSync(path.join(d, "step.mjs"), stepScript("hang", pidFile));
		const started = Date.now();
		const out = await runStep([process.execPath, path.join(d, "step.mjs")], {
			cwd: d,
			timeoutMs: 1_000,
			identity: callerIdentity(),
			stop: () => Promise.reject(new Error("the stop helper did not return")),
		});
		const elapsed = Date.now() - started;
		try {
			expect(out.stop.confirmed).toBe(false);
			expect(out.stop.reason).toBe("timeout");
			expect(out.stop.error).toMatch(/stop not established: the stop helper did not return/);
			expect(out.timedOut).toBe(true);
			// The leader never exited, so no exit status was collected, and the
			// whole call stayed well within its bound rather than hanging.
			expect(out.code).toBeNull();
			expect(elapsed).toBeLessThan(60_000);
		} finally {
			// The injected stop did nothing; clean up the survivors this test left.
			const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { leader: number; child: number };
			for (const pid of [pids.child, pids.leader]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		}
	});

	it("stops a step at its bound with its child and confirms it", async () => {
		const d = dir("anvilkit-stop-");
		const pidFile = path.join(d, "pids.json");
		writeFileSync(path.join(d, "step.mjs"), stepScript("hang", pidFile));
		const out = await runStep([process.execPath, path.join(d, "step.mjs")], {
			cwd: d,
			timeoutMs: 1_500,
			identity: callerIdentity(),
		});
		const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { leader: number; child: number };
		expect(out.timedOut).toBe(true);
		expect(out.signal).toBe("SIGKILL");
		expect(out.stop.reason).toBe("timeout");
		expect(out.stop.confirmed).toBe(true);
		expect(alive(pids.child)).toBe(false);
		expect(alive(pids.leader)).toBe(false);
	});
});

describe("reading a step's output file", () => {
	it("reads a regular file and refuses a FIFO, symbolic links, a device, a directory and an oversized file without blocking", () => {
		const d = dir("anvilkit-read-");
		const regular = path.join(d, "result.json");
		writeFileSync(regular, '{"ok":true}');
		expect(readStepOutput(regular, 1024).toString()).toBe('{"ok":true}');
		expect(() => readStepOutput(regular, 4)).toThrow(/exceeds 4 bytes/);
		const fifo = path.join(d, "fifo.json");
		execFileSync("mkfifo", [fifo]);
		const started = Date.now();
		expect(() => readStepOutput(fifo, 1024)).toThrow(/not a regular file/);
		expect(Date.now() - started).toBeLessThan(5_000);
		const toRegular = path.join(d, "link.json");
		symlinkSync(regular, toRegular);
		expect(() => readStepOutput(toRegular, 1024)).toThrow(/not a regular file/);
		const toDevice = path.join(d, "zero.json");
		symlinkSync("/dev/zero", toDevice);
		expect(() => readStepOutput(toDevice, 1024)).toThrow(/not a regular file/);
		expect(() => readStepOutput("/dev/null", 1024)).toThrow(/not a regular file/);
		expect(() => readStepOutput(d, 1024)).toThrow(/not a regular file/);
	});
});

// VAL-05/AC6 from an ordinary, non-PID-1 parent (this test process): a step
// under a setpriv identity leaves a detached process (double fork and
// setsid), reparented outside this process's subtree, in its own session
// and group. The group/session/descendant view that assumed a PID-1 parent
// does not see it; the identity scan does, and the step's stop kills it
// before runStep returns. The step UIDs are fresh, unused ones, so the
// stop's kill of every process of those UIDs touches nothing else on this
// host.
const ac6 = rootGate(["/usr/bin/setpriv", "/usr/bin/setsid", "/bin/sh"]);

function unusedUids(): [number, number] {
	const used = new Set([...scanProcesses().values()].flatMap((p) => p.uids));
	for (;;) {
		const u = 2_100_000_000 + Math.floor(Math.random() * 1_000_000) * 2;
		if (!used.has(u) && !used.has(u + 1)) return [u, u + 1];
	}
}

describe.skipIf(ac6.skip)("step stop independent of PID 1 (setpriv identity, non-PID-1 parent)", () => {
	it("terminates a detached setsid process the step left behind before the step's result is returned", async () => {
		ac6.assert();
		expect(process.pid).not.toBe(1);
		const [candidate, harness] = unusedUids();
		const identity: StepIdentity = {
			mode: "setpriv",
			uid: candidate,
			gid: candidate,
			harnessUid: harness,
			harnessGid: harness,
		};
		const d = dir("anvilkit-ac6-");
		chmodSync(d, 0o755);
		const out = path.join(d, "out");
		mkdirSync(out);
		chmodSync(out, 0o1777);
		// The leader records itself, leaves a detached sleeper in a new session
		// whose parent exits at once, and lingers so the test can look at both.
		const script = `echo $$ > ${out}/leader; (setsid sleep 600 & echo $! > ${out}/detached); sleep 2; exit 0`;
		const running = runStep(["/bin/sh", "-c", script], { cwd: d, timeoutMs: 30_000, identity });
		let pids: { leader: number; detached: number } | undefined;
		for (let i = 0; i < 100 && !pids; i++) {
			await new Promise((r) => setTimeout(r, 20));
			try {
				const leader = Number(readFileSync(path.join(out, "leader"), "utf8"));
				const detached = Number(readFileSync(path.join(out, "detached"), "utf8"));
				if (leader > 0 && detached > 0) pids = { leader, detached };
			} catch {
				// not yet
			}
		}
		if (!pids) throw new Error("the step did not record its processes");
		const procs = scanProcesses();
		const sleeper = procs.get(pids.detached);
		expect(sleeper?.uid).toBe(candidate);
		expect(sleeper?.session).toBe(pids.detached);
		// The parent-chain view (trusted process as PID 1) misses it; the identity scan finds it.
		expect(stepProcesses(procs, { root: process.pid, leader: pids.leader }).map((p) => p.pid)).not.toContain(
			pids.detached,
		);
		expect(identityProcesses(procs, [candidate, harness]).map((p) => p.pid)).toContain(pids.detached);
		const result = await running;
		expect(result.code).toBe(0);
		expect(result.stop.reason).toBe("exited");
		expect(result.stop.confirmed).toBe(true);
		expect(result.stop.signaled).toBeGreaterThanOrEqual(1);
		expect(alive(pids.detached)).toBe(false);
		expect(identityProcesses(scanProcesses(), [candidate, harness])).toEqual([]);
	});

	it("runs the harness under its own UID, stopped and confirmed with the candidate's", async () => {
		ac6.assert();
		const [candidate, harness] = unusedUids();
		const identity: StepIdentity = {
			mode: "setpriv",
			uid: candidate,
			gid: candidate,
			harnessUid: harness,
			harnessGid: harness,
		};
		const d = dir("anvilkit-ac6-");
		chmodSync(d, 0o755);
		// The harness reports its own identity on the orchestrator's pipe and
		// leaves a detached process of its UID behind.
		const step = await runStep(["/bin/sh", "-c", "(setsid sleep 600 &); id -u >&3; id -g >&3"], {
			cwd: d,
			timeoutMs: 30_000,
			identity,
			runAs: "harness",
			report: { maxBytes: 1024 },
		});
		expect(step.report?.bytes.toString().trim().split("\n")).toEqual([String(harness), String(harness)]);
		expect(step.stop.confirmed).toBe(true);
		expect(identityProcesses(scanProcesses(), [candidate, harness])).toEqual([]);
		await expect(
			runStep(["/bin/true"], {
				cwd: d,
				timeoutMs: 5_000,
				identity: { ...identity, harnessUid: candidate },
				runAs: "harness",
			}),
		).rejects.toThrow(/harness uid other than the candidate's/);
	});
});

describe.skipIf(ac6.skip)("step UIDs that are not the validator's alone", () => {
	it("refuses to start a step while a process of a step UID it did not start is alive", async () => {
		ac6.assert();
		const [candidate, harness] = unusedUids();
		const identity: StepIdentity = {
			mode: "setpriv",
			uid: candidate,
			gid: candidate,
			harnessUid: harness,
			harnessGid: harness,
		};
		const foreign = spawn(
			"setpriv",
			[`--reuid=${harness}`, `--regid=${harness}`, "--clear-groups", "--", "/bin/sleep", "600"],
			{ stdio: "ignore" },
		);
		try {
			for (let i = 0; i < 100 && identityProcesses(scanProcesses(), [harness]).length === 0; i++)
				await new Promise((r) => setTimeout(r, 20));
			await expect(runStep(["/bin/true"], { cwd: "/", timeoutMs: 5_000, identity })).rejects.toThrow(
				/already run 1 process\(es\).*must be the validator's alone/,
			);
			// Nothing was signaled: the foreign process is untouched.
			expect(alive(foreign.pid as number)).toBe(true);
		} finally {
			foreign.kill("SIGKILL");
		}
	});
});

// The Job's actual process topology and capability set: the trusted process
// is PID 1 of its own PID namespace (unshare, as the container runtime
// provides) running as UID 0 with SETUID, SETGID and SETPCAP only (setpriv,
// the harness template's capability set), the steps run as UID 10001
// through the validator's own setpriv drop. Without CAP_KILL the trusted
// process cannot signal the steps; the stop must run as the step identity
// and be confirmed from PID 1's read of /proc.
const pid1 = rootGate(["/usr/bin/unshare", "/usr/bin/setpriv"]);

describe.skipIf(pid1.skip)("step stop under the Job's UID and capability set (PID 1, no CAP_KILL)", () => {
	it("stops and confirms after a normal leader exit and at the bound, leaving no survivor", () => {
		pid1.assert();
		// A world-readable stage: the compiled workers, this Node, the probe and
		// the steps (UID 10001 cannot traverse a private home directory).
		const stage = dir("anvilkit-stop-ns-");
		chmodSync(stage, 0o755);
		execFileSync(
			process.execPath,
			[
				path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
				"-p",
				"tsconfig.build.json",
				"--outDir",
				stage,
			],
			{ cwd: packageRoot, stdio: "pipe" },
		);
		cpSync(process.execPath, path.join(stage, "node"));
		const scratchDir = path.join(stage, "scratch");
		mkdirSync(scratchDir);
		chmodSync(scratchDir, 0o1777);
		writeFileSync(path.join(stage, "step-exit.mjs"), stepScript("exit", path.join(scratchDir, "exit.json")));
		writeFileSync(path.join(stage, "step-hang.mjs"), stepScript("hang", path.join(scratchDir, "hang.json")));
		writeFileSync(
			path.join(stage, "probe.mjs"),
			`
import { readFileSync, existsSync } from "node:fs";
import { runStep, scanProcesses, stepProcesses } from "./isolation.js";
const identity = { mode: "setpriv", uid: 10001, gid: 10001 };
const stage = ${JSON.stringify(stage)};
const scratch = ${JSON.stringify(scratchDir)};
const caps = /^CapEff:\\s+(\\w+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
const out = { pid: process.pid, uid: process.getuid(), capEff: caps };
const exitRun = await runStep([stage + "/node", stage + "/step-exit.mjs"], { cwd: scratch, timeoutMs: 20000, identity });
const exitPids = JSON.parse(readFileSync(scratch + "/exit.json", "utf8"));
out.exit = { code: exitRun.code, timedOut: exitRun.timedOut, stop: exitRun.stop, pids: exitPids, stderr: exitRun.stderr.slice(-300) };
// While the hanging step runs, this process tries to signal it: EPERM shows the missing CAP_KILL.
const hangRun = runStep([stage + "/node", stage + "/step-hang.mjs"], { cwd: scratch, timeoutMs: 2500, identity });
let hangPids;
for (let i = 0; i < 100 && !hangPids; i++) {
  await new Promise((r) => setTimeout(r, 50));
  if (existsSync(scratch + "/hang.json")) hangPids = JSON.parse(readFileSync(scratch + "/hang.json", "utf8"));
}
try { process.kill(hangPids.child, "SIGKILL"); out.killFromRoot = "ok"; } catch (err) { out.killFromRoot = err.code; }
const hang = await hangRun;
out.hang = { code: hang.code, signal: hang.signal, timedOut: hang.timedOut, stop: hang.stop, pids: hangPids, stderr: hang.stderr.slice(-300) };
const procs = scanProcesses();
out.survivors = [...procs.values()].filter((p) => p.pid !== process.pid && p.state !== "Z" && p.state !== "X").map((p) => [p.pid, p.uid, p.state]);
out.leftExit = stepProcesses(procs, { root: process.pid, leader: exitPids.leader }).length;
out.leftHang = stepProcesses(procs, { root: process.pid, leader: hangPids.leader }).length;
console.log(JSON.stringify(out));
`,
		);
		execFileSync("chmod", ["-R", "a+rX", stage]);
		const run = spawnSync(
			"unshare",
			[
				"--pid",
				"--fork",
				"--mount-proc",
				"--",
				"setpriv",
				"--bounding-set=-all,+setuid,+setgid,+setpcap",
				"--inh-caps=-all",
				"--",
				path.join(stage, "node"),
				path.join(stage, "probe.mjs"),
			],
			{ env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8", timeout: 170_000 },
		);
		expect(run.status, run.stderr).toBe(0);
		const out = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as {
			pid: number;
			uid: number;
			capEff: string;
			killFromRoot: string;
			exit: { code: number; timedOut: boolean; stop: { reason: string; confirmed: boolean; signaled: number } };
			hang: { signal: string; timedOut: boolean; stop: { reason: string; confirmed: boolean; signaled: number } };
			survivors: unknown[];
			leftExit: number;
			leftHang: number;
		};
		expect(out.pid).toBe(1);
		expect(out.uid).toBe(0);
		expect(out.capEff).toBe("00000000000001c0");
		expect(out.killFromRoot).toBe("EPERM");
		expect(out.exit.code).toBe(0);
		expect(out.exit.stop).toEqual({ reason: "exited", confirmed: true, signaled: expect.any(Number) });
		expect(out.hang.timedOut).toBe(true);
		expect(out.hang.signal).toBe("SIGKILL");
		expect(out.hang.stop.reason).toBe("timeout");
		expect(out.hang.stop.confirmed).toBe(true);
		expect(out.survivors).toEqual([]);
		expect(out.leftExit).toBe(0);
		expect(out.leftHang).toBe(0);
	});
});
