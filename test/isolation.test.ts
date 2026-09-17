import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callerIdentity, runStep, scanProcesses, stepProcesses } from "../src/isolation.js";
import { packageRoot } from "./helpers.js";

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

// The Job's actual process topology and capability set: the trusted process
// is PID 1 of its own PID namespace (unshare, as the container runtime
// provides) running as UID 0 with SETUID, SETGID and SETPCAP only (setpriv,
// the harness template's capability set), the steps run as UID 10001
// through the validator's own setpriv drop. Without CAP_KILL the trusted
// process cannot signal the steps; the stop must run as the step identity
// and be confirmed from PID 1's read of /proc.
const tools = {
	root: process.getuid?.() === 0,
	unshare: existsSync("/usr/bin/unshare"),
	setpriv: existsSync("/usr/bin/setpriv"),
};
const skipReason = !tools.root
	? "needs a root caller (UID 10001 steps)"
	: !tools.unshare || !tools.setpriv
		? "needs util-linux unshare and setpriv"
		: "";

describe.skipIf(skipReason !== "")("step stop under the Job's UID and capability set (PID 1, no CAP_KILL)", () => {
	it("stops and confirms after a normal leader exit and at the bound, leaving no survivor", () => {
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
