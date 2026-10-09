// Process boundary of the steps that touch candidate content (DD-03 §5,
// DD-04 §2–§3): the build, the SSR render, the SSR harness that judges the
// render, and the browser host run in child processes; the trusted
// orchestrator never imports candidate modules. A step hands its report to
// the orchestrator over an inherited descriptor (fd 3) of a pipe the
// orchestrator owns, never through a file the step could write, and it gets
// its inputs on stdin; the only step outputs read from disk are the build's
// artifacts, each through readStepOutput (O_NOFOLLOW, a regular file only,
// bounded). Inside the Job image the steps run through util-linux's setpriv
// (real/effective/saved UID and GID set, supplementary groups cleared,
// bounding and inheritable capability sets emptied, no_new_privs), which is
// the reviewed drop of P09 expressed with a maintained tool rather than a
// copy of the codegen supervisor: the candidate identity (UID/GID 10001)
// for the build, the SSR render child and the browser host, and a separate
// harness identity (UID/GID 10003) for the protected SSR harness that
// judges the render, so code that executes candidate source never shares a
// UID with the code that judges it. On a developer host the steps run as
// the caller, and the evidence records which of the two it was.
//
// Stopping a step (P09 R2, VAL-05): the trusted process is UID 0 with
// SETUID, SETGID and SETPCAP only. Without CAP_KILL it cannot signal a step
// process, so neither the group kill nor a parent-death signal establishes
// anything about the step identities. What can signal them is each identity
// itself: after every step — at its bound and after a normal leader exit
// alike, since a leader may exit and leave processes behind — the trusted
// process runs, for every step identity that still has a live process, the
// shell's kill builtin on pid -1 under that identity's setpriv drop (the
// kernel then signals every process of that UID in the PID namespace, the
// helper itself excepted, whatever its parent, process group or session),
// round after round, and confirms from its own scan of /proc that no live
// process whose real, effective or saved UID is a step UID remains. The
// confirmation does not depend on the trusted process being PID 1 or a
// subreaper: a detached process (double fork and setsid) left by a step is
// found by its UID wherever it was reparented. It requires that the step
// UIDs belong to the validator's steps alone in its PID namespace, as they
// do in the validator and the codegen team containers (the team runs the
// validator only after its coder is confirmed stopped); a step does not
// start while any process of a step UID is alive, since such a process is
// not the validator's and the stop would kill it. A stop that cannot
// be confirmed is not an outcome: the caller treats the step as unobserved
// (OBSERVER_FAILED), nothing it produced is read, no later step runs and
// nothing is certified. On a developer host (caller identity) the trusted
// process signals the step's group, session and descendants itself; that
// mode confirms no detached process and is never the Job's.
import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface StepIdentity {
	mode: "caller" | "setpriv";
	/** The candidate identity: the build, the SSR render child and the browser host run as it. */
	uid?: number;
	gid?: number;
	/** The SSR harness identity (setpriv): judges the render under a UID other than the candidate's. */
	harnessUid?: number;
	harnessGid?: number;
}

export interface StepOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs: number;
	identity: StepIdentity;
	/** Which identity of `identity` the step runs as (default: the candidate's). */
	runAs?: "candidate" | "harness";
	/** Bytes written to the step's stdin, which is then closed (default: no stdin). */
	input?: string;
	/** Collects the report the step writes to fd 3, bounded (default: no fd 3). */
	report?: { maxBytes: number };
	maxOutputBytes?: number;
	/**
	 * Test seam: replaces how the step's processes are stopped (never set by
	 * the Job or the CLI). It lets a test drive the failed-stop path — a stop
	 * that does not establish the kill while the leader is still alive — and
	 * assert that the step still settles within a bound as OBSERVER_FAILED.
	 */
	stop?: (leader: number, identity: StepIdentity) => Promise<{ signaled: number }>;
}

/** How a step's execution ended and whether the trusted process confirmed its stop. */
export interface StepStop {
	/** Why execution ended: the leader exited on its own, or the step was stopped at its bound. */
	reason: "exited" | "timeout";
	/** True when the trusted process's own read of /proc found no process of the step after the stop. */
	confirmed: boolean;
	/** Live processes of the step the stop found and signaled (beyond the group kill of the caller mode). */
	signaled: number;
	/** Why the stop is not established; unset when confirmed. */
	error?: string;
}

export interface StepOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	/** What the step wrote to fd 3 (only when requested), complete only once the stop is confirmed. */
	report?: { bytes: Buffer; truncated: boolean };
	durationMs: number;
	stop: StepStop;
}

/** The current process's identity choice for candidate steps. */
export function callerIdentity(): StepIdentity {
	return { mode: "caller" };
}

/** The Job's step identities: the candidate UID/GID 10001 and the SSR harness UID/GID 10003. */
export function setprivIdentity(
	candidate = { uid: 10001, gid: 10001 },
	harness = { uid: 10003, gid: 10003 },
): StepIdentity {
	return { mode: "setpriv", uid: candidate.uid, gid: candidate.gid, harnessUid: harness.uid, harnessGid: harness.gid };
}

/**
 * Argv of a trusted worker script beside this module: the compiled .js in
 * the image, the .ts source through tsx during development.
 */
export function workerArgv(name: string): string[] {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const js = path.join(here, `${name}.js`);
	if (existsSync(js)) return [process.execPath, js];
	const ts = path.join(here, `${name}.ts`);
	if (existsSync(ts)) return [process.execPath, "--import", "tsx", ts];
	throw new Error(`worker ${name} not found beside ${here}`);
}

/** The UIDs a setpriv identity runs steps as (candidate and harness); every one is stopped and confirmed after every step. */
export function stepUids(identity: StepIdentity): number[] {
	if (identity.mode === "caller") return [];
	return [identity.uid, identity.harnessUid].filter((u): u is number => u !== undefined);
}

function dropTo(uid: number | undefined, gid: number | undefined): string[] {
	if (uid === undefined || gid === undefined || uid === 0 || gid === 0) {
		throw new Error("setpriv identity needs a non-root uid and gid");
	}
	return [
		"setpriv",
		`--reuid=${uid}`,
		`--regid=${gid}`,
		"--clear-groups",
		"--inh-caps=-all",
		"--bounding-set=-all",
		"--no-new-privs",
		"--",
	];
}

function wrap(argv: string[], identity: StepIdentity, runAs: "candidate" | "harness"): string[] {
	if (identity.mode === "caller") return argv;
	if (runAs === "candidate") return [...dropTo(identity.uid, identity.gid), ...argv];
	if (identity.harnessUid === undefined || identity.harnessUid === identity.uid)
		throw new Error("setpriv identity needs a harness uid other than the candidate's");
	return [...dropTo(identity.harnessUid, identity.harnessGid), ...argv];
}

/** One entry of /proc as the stop reads it. */
export interface ProcessEntry {
	pid: number;
	ppid: number;
	pgrp: number;
	session: number;
	/** Real UID. */
	uid: number;
	/** Real, effective, saved and filesystem UID. */
	uids: number[];
	state: string;
}

/** pid, parent, group, session, UIDs and state of every process visible in /proc. */
export function scanProcesses(): Map<number, ProcessEntry> {
	const procs = new Map<number, ProcessEntry>();
	for (const name of readdirSync("/proc")) {
		if (!/^[0-9]+$/.test(name)) continue;
		const pid = Number(name);
		let stat: string;
		let status: string;
		try {
			stat = readFileSync(`/proc/${name}/stat`, "utf8");
			status = readFileSync(`/proc/${name}/status`, "utf8");
		} catch {
			continue; // exited between the listing and the read
		}
		// "pid (comm) state ppid pgrp session ..." — comm may hold spaces and parentheses.
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const uids = (/^Uid:\s+(.*)$/m.exec(status)?.[1] ?? "").trim().split(/\s+/).map(Number);
		procs.set(pid, {
			pid,
			ppid: Number(tail[1]),
			pgrp: Number(tail[2]),
			session: Number(tail[3]),
			uid: Number.isInteger(uids[0]) ? (uids[0] as number) : -1,
			uids: uids.filter((u) => Number.isInteger(u)),
			state: tail[0] ?? "?",
		});
	}
	return procs;
}

const live = (p: ProcessEntry) => p.state !== "Z" && p.state !== "X";

/**
 * The live processes (not zombies) that belong to a caller-mode step:
 * members of its process group or session (the leader started its own
 * session), and every descendant of the trusted process (root) on the
 * parent chain. root itself is never included. This is the development
 * host's view only: a detached process reparented outside root's subtree
 * is not in it, which is why the Job's steps run under setpriv and are
 * confirmed by identityProcesses.
 */
export function stepProcesses(
	procs: Map<number, ProcessEntry>,
	step: { root: number; leader: number },
): ProcessEntry[] {
	const out: ProcessEntry[] = [];
	for (const p of procs.values()) {
		if (p.pid === step.root || !live(p)) continue;
		let member = p.pgrp === step.leader || p.session === step.leader || p.pid === step.leader;
		let cur = p.ppid;
		for (let hops = 0; !member && cur > 0 && hops < 1024; hops++) {
			if (cur === step.root) member = true;
			const parent = procs.get(cur);
			if (!parent) break;
			cur = parent.ppid;
		}
		if (member) out.push(p);
	}
	return out;
}

/** The live processes (not zombies) whose real, effective or saved UID is one of uids, wherever they were reparented. */
export function identityProcesses(procs: Map<number, ProcessEntry>, uids: number[]): ProcessEntry[] {
	const set = new Set(uids);
	return [...procs.values()].filter((p) => live(p) && p.uids.slice(0, 3).some((u) => set.has(u)));
}

/** What remains of a step on this process's own read of /proc: by UID under setpriv, by group/session/descendant as the caller. */
export function remainingProcesses(
	procs: Map<number, ProcessEntry>,
	step: { root: number; leader: number },
	identity: StepIdentity,
): ProcessEntry[] {
	return identity.mode === "setpriv" ? identityProcesses(procs, stepUids(identity)) : stepProcesses(procs, step);
}

const stopRounds = 300;
const stopHelperBoundMs = 60_000;
const killHelperBoundMs = 10_000;
// The bound the final exit read must not exceed after a stop that could
// not be established (a failed helper leaving the leader alive): without
// it the step would wait for an exit that never comes. When the stop was
// confirmed the leader has already been reaped, so this returns at once.
const leaderExitBoundMs = 10_000;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Caller mode: kills the step's group and then every live process of the
 * step (group, session, descendants of root) round after round until none
 * is left. Returns the number of processes signaled individually; throws
 * when a process refuses the signal, or when live processes remain after
 * the bounded rounds.
 */
export function killStepProcesses(step: { root: number; leader: number }): { signaled: number } {
	try {
		process.kill(-step.leader, "SIGKILL");
	} catch {
		// the group is gone (the rounds below decide)
	}
	let signaled = 0;
	for (let round = 0; round < stopRounds; round++) {
		const left = stepProcesses(scanProcesses(), step);
		if (left.length === 0) return { signaled };
		for (const p of left) {
			try {
				process.kill(p.pid, "SIGKILL");
				signaled++;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ESRCH") continue;
				throw new Error(`pid ${p.pid} (uid ${p.uid}): ${code ?? (err as Error).message}`);
			}
		}
		pause(Math.min(50, (round + 1) * 5));
	}
	throw new Error("processes of the step are still alive after the bounded rounds");
}

/** Runs `kill -s KILL -- -1` under one step identity's setpriv drop: every process of that UID but the helper is signaled. */
function killAllOf(uid: number, gid: number): Promise<void> {
	const argv = [...dropTo(uid, gid), "/bin/sh", "-c", "kill -s KILL -- -1"];
	return new Promise((resolve, reject) => {
		const helper = spawn(argv[0] as string, argv.slice(1), {
			cwd: "/",
			env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		helper.stderr.on("data", (c: Buffer) => {
			stderr = (stderr + c.toString("utf8")).slice(0, 2048);
		});
		const bound = setTimeout(() => {
			// A helper this process cannot signal either: the stop is not established.
			reject(new Error(`the stop helper of uid ${uid} did not return within ${killHelperBoundMs} ms`));
		}, killHelperBoundMs);
		helper.on("error", (err) => {
			clearTimeout(bound);
			reject(new Error(`start the stop helper: ${err.message}`));
		});
		// The helper's exit status is not evidence (kill reports ESRCH when
		// nothing was left to signal); the scan that follows decides.
		helper.on("close", (code) => {
			clearTimeout(bound);
			if (code === 126 || code === 127) reject(new Error(`the stop helper could not run: ${stderr.trim()}`));
			else resolve();
		});
	});
}

/**
 * setpriv mode: until no live process of a step UID remains on this
 * process's own read of /proc, kills every process of each such UID under
 * that UID's drop, round after round. Returns the number of live step
 * processes found and signaled.
 */
async function stopIdentities(identity: StepIdentity): Promise<{ signaled: number }> {
	const gidOf = new Map<number, number | undefined>([
		[identity.uid as number, identity.gid],
		[identity.harnessUid as number, identity.harnessGid],
	]);
	const uids = stepUids(identity);
	let signaled = 0;
	const until = Date.now() + stopHelperBoundMs;
	for (let round = 0; round < stopRounds && Date.now() < until; round++) {
		const left = identityProcesses(scanProcesses(), uids);
		if (left.length === 0) return { signaled };
		signaled += left.length;
		for (const uid of new Set(left.flatMap((p) => p.uids.slice(0, 3).filter((u) => uids.includes(u))))) {
			await killAllOf(uid, gidOf.get(uid) as number);
		}
		await new Promise((r) => setTimeout(r, Math.min(50, (round + 1) * 5)));
	}
	throw new Error("processes of the step identities are still alive after the bounded rounds");
}

/** Runs the stop of a step: by identity under setpriv, by group/session/descendant in this process as the caller. */
function stopStep(leader: number, identity: StepIdentity): Promise<{ signaled: number }> {
	if (identity.mode === "caller") return Promise.resolve(killStepProcesses({ root: process.pid, leader }));
	return stopIdentities(identity);
}

/** Resolves true when the promise settles within the bound, false otherwise (the timer never outlives the wait). */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		p.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}

/**
 * Runs one step with a bounded lifetime in its own session and process
 * group, stops what it left behind (at the bound or after the leader's
 * exit) and confirms the stop from this process's own read of /proc. The
 * report the step wrote to fd 3 is complete only when the stop is
 * confirmed: every writer is gone and the pipe closed.
 */
export function runStep(argv: string[], opts: StepOptions): Promise<StepOutcome> {
	const started = Date.now();
	const max = opts.maxOutputBytes ?? 1 << 20;
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			const command = wrap(argv, opts.identity, opts.runAs ?? "candidate");
			const foreign = identityProcesses(scanProcesses(), stepUids(opts.identity));
			if (foreign.length)
				throw new Error(
					`step UID(s) ${stepUids(opts.identity).join(", ")} already run ${foreign.length} process(es) (pid ${foreign
						.slice(0, 5)
						.map((p) => p.pid)
						.join(", ")}) in this PID namespace: the step UIDs must be the validator's alone`,
				);
			child = spawn(command[0] as string, command.slice(1), {
				cwd: opts.cwd,
				env: {
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
					HOME: opts.cwd,
					TMPDIR: opts.cwd,
					...(opts.env ?? {}),
				},
				stdio: [
					opts.input !== undefined ? "pipe" : "ignore",
					"pipe",
					"pipe",
					...(opts.report ? ["pipe" as const] : []),
				],
				detached: true,
			});
		} catch (err) {
			reject(err);
			return;
		}
		if (!child.pid) {
			reject(new Error("the step did not start"));
			return;
		}
		const leader = child.pid;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const take = (which: "stdout" | "stderr", chunk: Buffer) => {
			const s = chunk.toString("utf8");
			if (which === "stdout") stdout = (stdout + s).slice(0, max);
			else stderr = (stderr + s).slice(0, max);
		};
		child.stdout?.on("data", (c) => take("stdout", c));
		child.stderr?.on("data", (c) => take("stderr", c));
		if (opts.input !== undefined && child.stdin) {
			// A step that exits without reading its input is not an error here.
			child.stdin.on("error", () => {});
			child.stdin.end(opts.input);
		}
		const reportChunks: Buffer[] = [];
		let reportBytes = 0;
		let reportTruncated = false;
		const reportStream = opts.report ? (child.stdio[3] as NodeJS.ReadableStream | null) : null;
		reportStream?.on("data", (c: Buffer) => {
			const room = (opts.report?.maxBytes ?? 0) - reportBytes;
			if (c.length > room) reportTruncated = true;
			if (room > 0) reportChunks.push(c.subarray(0, room));
			reportBytes += Math.min(c.length, Math.max(room, 0));
		});
		const closed = new Promise<void>((r) => child.once("close", () => r()));
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
			child.once("exit", (code, signal) => r({ code, signal })),
		);
		let stopping: Promise<void> | undefined;
		const settle = async (reason: StepStop["reason"]) => {
			const stop: StepStop = { reason, confirmed: false, signaled: 0 };
			try {
				stop.signaled = (await (opts.stop ?? stopStep)(leader, opts.identity)).signaled;
				// The leader must have been reaped (its exit collected here),
				// nothing of the step may remain on this process's own read, and
				// every descriptor the step held (its output and report pipes)
				// must be closed, so that nothing it wrote is still in flight.
				if (!(await within(exited, stopHelperBoundMs))) throw new Error("the leader did not exit after the stop");
				const left = remainingProcesses(scanProcesses(), { root: process.pid, leader }, opts.identity);
				if (left.length) throw new Error(`${left.length} process(es) of the step still alive after the stop`);
				if (!(await within(closed, 5_000))) throw new Error("the step's pipes did not close after the stop");
				stop.confirmed = true;
			} catch (err) {
				stop.error = `stop not established: ${(err as Error).message}`;
			}
			// Collect what the step left, but never wait past a bound: a stop
			// that could not be established may leave the leader alive, and this
			// must still resolve so the caller treats the step as unobserved
			// (OBSERVER_FAILED) instead of hanging on an exit that never comes.
			// A confirmed stop has already reaped the leader, so this returns at
			// once; the Job's own cleanup reclaims any survivor.
			const ended = await within(exited, leaderExitBoundMs);
			const { code, signal } = ended ? await exited : { code: null, signal: null };
			const out: StepOutcome = { code, signal, timedOut, stdout, stderr, durationMs: Date.now() - started, stop };
			if (opts.report) out.report = { bytes: Buffer.concat(reportChunks), truncated: reportTruncated };
			resolve(out);
		};
		const timer = setTimeout(() => {
			if (stopping) return;
			timedOut = true;
			stopping = settle("timeout");
		}, opts.timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", () => {
			clearTimeout(timer);
			if (stopping) return;
			stopping = settle("exited");
		});
	});
}

/**
 * Reads one file a step produced, refusing anything but a regular file: no
 * symbolic link (O_NOFOLLOW), no FIFO, socket or device (refused from
 * lstat before any open, and by fstat of the descriptor, which must be the
 * same inode; O_NONBLOCK keeps even a swapped-in FIFO from blocking the
 * open), and no more than maxBytes. Only for files under directories the
 * caller already established as real directories of a stopped step.
 */
export function readStepOutput(file: string, maxBytes: number): Buffer {
	const before = lstatSync(file);
	if (!before.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev)
			throw new Error(`${path.basename(file)} is not the regular file it was`);
		if (st.size > maxBytes) throw new Error(`${path.basename(file)} exceeds ${maxBytes} bytes`);
		const buf = Buffer.alloc(st.size + 1);
		let off = 0;
		for (;;) {
			const n = readSync(fd, buf, off, buf.length - off, off);
			if (n === 0) break;
			off += n;
			if (off > st.size) throw new Error(`${path.basename(file)} changed while being read`);
		}
		return buf.subarray(0, off);
	} finally {
		closeSync(fd);
	}
}

/** Writes a step's report to the inherited fd 3 (the orchestrator's pipe) completely. */
export function writeReport(text: string, fd = 3): void {
	const bytes = Buffer.from(text, "utf8");
	let off = 0;
	while (off < bytes.length) {
		try {
			off += writeSync(fd, bytes, off, bytes.length - off);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
			pause(5);
		}
	}
}
