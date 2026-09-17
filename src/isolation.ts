// Process boundary of the steps that touch candidate content (DD-03 §5,
// DD-04 §2–§3): the build, the SSR render and the browser host run in child
// processes; the trusted orchestrator never imports candidate modules and
// reads only the files those steps leave behind. Inside the Job image the
// steps run under the candidate identity through util-linux's setpriv
// (real/effective/saved UID and GID 10001, supplementary groups cleared,
// bounding and inheritable capability sets emptied, no_new_privs), which is
// the reviewed drop of P09 expressed with a maintained tool rather than a
// copy of the codegen supervisor; on a developer host the steps run as the
// caller, and the evidence records which of the two it was.
//
// Stopping a step (P09 R2, DD-03 §5): the trusted process is UID 0 with
// SETUID, SETGID and SETPCAP only. Without CAP_KILL it cannot signal a
// UID 10001 process, so neither the group kill nor a parent-death signal
// establishes anything about the candidate identity. What can signal the
// step's processes is the step identity itself: after every step — at its
// bound and after a normal leader exit alike, since a leader may exit and
// leave descendants behind — the stop helper (candidate-stop-worker) runs
// under the same setpriv drop, kills the step's process group and then
// every live process of the step it can still find (group members, session
// members and descendants of the trusted process, which is PID 1 of the
// Job container and therefore the parent every orphan is reparented to),
// round after round, until none is left. The trusted process then confirms
// from its own read of /proc, never from the helper's report, that no
// process of the step remains. A stop that cannot be confirmed is not an
// outcome: the caller treats the step as unobserved (OBSERVER_FAILED), no
// later step runs and nothing is certified. On a developer host (caller
// identity) the trusted process signals the same set itself.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface StepIdentity {
	mode: "caller" | "setpriv";
	uid?: number;
	gid?: number;
}

export interface StepOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs: number;
	identity: StepIdentity;
	maxOutputBytes?: number;
}

/** How a step's execution ended and whether the trusted process confirmed its stop. */
export interface StepStop {
	/** Why execution ended: the leader exited on its own, or the step was stopped at its bound. */
	reason: "exited" | "timeout";
	/** True when the trusted process's own read of /proc found no process of the step after the stop. */
	confirmed: boolean;
	/** Processes the stop signaled individually after the group kill (descendants the leader left behind). */
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
	durationMs: number;
	stop: StepStop;
}

/** The current process's identity choice for candidate steps. */
export function callerIdentity(): StepIdentity {
	return { mode: "caller" };
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

function wrap(argv: string[], identity: StepIdentity): string[] {
	if (identity.mode === "caller") return argv;
	if (identity.uid === undefined || identity.gid === undefined || identity.uid === 0 || identity.gid === 0) {
		throw new Error("setpriv identity needs a non-root uid and gid");
	}
	return [
		"setpriv",
		`--reuid=${identity.uid}`,
		`--regid=${identity.gid}`,
		"--clear-groups",
		"--inh-caps=-all",
		"--bounding-set=-all",
		"--no-new-privs",
		"--",
		...argv,
	];
}

/** One entry of /proc as the stop reads it. */
export interface ProcessEntry {
	pid: number;
	ppid: number;
	pgrp: number;
	session: number;
	uid: number;
	state: string;
}

/** pid, parent, group, session, real UID and state of every process visible in /proc. */
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
		const uid = /^Uid:\s+(\d+)/m.exec(status);
		procs.set(pid, {
			pid,
			ppid: Number(tail[1]),
			pgrp: Number(tail[2]),
			session: Number(tail[3]),
			uid: uid ? Number(uid[1]) : -1,
			state: tail[0] ?? "?",
		});
	}
	return procs;
}

/**
 * The live processes (not zombies) that belong to a step: members of its
 * process group or session (the leader started its own session), and every
 * descendant of the trusted process (root) on the parent chain — where the
 * trusted process is PID 1 of its namespace, as in the Job container, that
 * is every orphan the step left. root itself and skip are never included.
 */
export function stepProcesses(
	procs: Map<number, ProcessEntry>,
	step: { root: number; leader: number },
	skip = 0,
): ProcessEntry[] {
	const out: ProcessEntry[] = [];
	for (const p of procs.values()) {
		if (p.pid === step.root || p.pid === skip || p.state === "Z" || p.state === "X") continue;
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

const stopRounds = 300;
const stopHelperBoundMs = 60_000;

/**
 * Kills the step's group and then every live process of the step this
 * identity can signal, round after round, until none is left. Returns the
 * number of processes signaled individually; throws when a process refuses
 * the signal for a reason other than its identity, or when live processes
 * remain after the bounded rounds.
 */
export function killStepProcesses(step: { root: number; leader: number }, skip = 0): { signaled: number } {
	try {
		process.kill(-step.leader, "SIGKILL");
	} catch {
		// the group is gone, or not ours to signal (the rounds below decide)
	}
	let signaled = 0;
	const own = process.getuid?.() ?? -1;
	for (let round = 0; round < stopRounds; round++) {
		const live = stepProcesses(scanProcesses(), step, skip);
		if (live.length === 0) return { signaled };
		for (const p of live) {
			try {
				process.kill(p.pid, "SIGKILL");
				signaled++;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ESRCH") continue;
				if (code === "EPERM" && p.uid !== own) continue; // not this identity: it becomes ours once dropped, or the rounds run out
				throw new Error(`pid ${p.pid} (uid ${p.uid}): ${code ?? (err as Error).message}`);
			}
		}
		const delay = Math.min(50, (round + 1) * 5);
		const until = Date.now() + delay;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - Date.now());
	}
	throw new Error("processes of the step are still alive after the bounded rounds");
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

/** Runs the stop under the step identity (the helper) or in this process (caller mode). */
function stopStep(leader: number, identity: StepIdentity): Promise<{ signaled: number }> {
	const step = { root: process.pid, leader };
	if (identity.mode === "caller") return Promise.resolve(killStepProcesses(step));
	const argv = wrap(
		[...workerArgv("candidate-stop-worker"), "--root", String(step.root), "--leader", String(leader)],
		identity,
	);
	return new Promise((resolve, reject) => {
		const helper = spawn(argv[0] as string, argv.slice(1), {
			env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		helper.stdout.on("data", (c: Buffer) => {
			stdout = (stdout + c.toString("utf8")).slice(0, 4096);
		});
		helper.stderr.on("data", (c: Buffer) => {
			stderr = (stderr + c.toString("utf8")).slice(0, 4096);
		});
		const bound = setTimeout(() => {
			// A helper this process cannot signal either: the stop is not established.
			reject(new Error(`the stop helper did not return within ${stopHelperBoundMs} ms`));
		}, stopHelperBoundMs);
		helper.on("error", (err) => {
			clearTimeout(bound);
			reject(new Error(`start the stop helper: ${err.message}`));
		});
		helper.on("close", (code) => {
			clearTimeout(bound);
			if (code !== 0) {
				reject(new Error(`the stop helper exited ${code}: ${stderr.trim() || "no detail"}`));
				return;
			}
			try {
				const report = JSON.parse(stdout) as { signaled?: number };
				resolve({ signaled: typeof report.signaled === "number" ? report.signaled : 0 });
			} catch {
				reject(new Error(`the stop helper reported nothing readable: ${stderr.trim()}`));
			}
		});
	});
}

/**
 * Runs one step with a bounded lifetime in its own session and process
 * group, stops what it left behind (at the bound or after the leader's
 * exit) and confirms the stop from this process's own read of /proc.
 */
export function runStep(argv: string[], opts: StepOptions): Promise<StepOutcome> {
	const command = wrap(argv, opts.identity);
	const started = Date.now();
	const max = opts.maxOutputBytes ?? 1 << 20;
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(command[0] as string, command.slice(1), {
				cwd: opts.cwd,
				env: {
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
					HOME: opts.cwd,
					TMPDIR: opts.cwd,
					...(opts.env ?? {}),
				},
				stdio: ["ignore", "pipe", "pipe"],
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
		const closed = new Promise<void>((r) => child.once("close", () => r()));
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
			child.once("exit", (code, signal) => r({ code, signal })),
		);
		let stopping: Promise<void> | undefined;
		const settle = async (reason: StepStop["reason"]) => {
			const stop: StepStop = { reason, confirmed: false, signaled: 0 };
			try {
				stop.signaled = (await stopStep(leader, opts.identity)).signaled;
				// The leader must have been reaped (its exit collected here) and
				// nothing of the step may remain on this process's own read.
				if (!(await within(exited, stopHelperBoundMs))) throw new Error("the leader did not exit after the stop");
				const left = stepProcesses(scanProcesses(), { root: process.pid, leader });
				if (left.length) throw new Error(`${left.length} process(es) of the step still alive after the stop`);
				stop.confirmed = true;
			} catch (err) {
				stop.error = `stop not established: ${(err as Error).message}`;
			}
			// Descendants holding the pipes are gone now; collect what was written.
			await within(closed, 5_000);
			const { code, signal } = await exited;
			resolve({ code, signal, timedOut, stdout, stderr, durationMs: Date.now() - started, stop });
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
