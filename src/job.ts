// The validator Job (DD-03 §4–§6, DD-04 §3, delivery.md P10d): the trusted
// process of the anvilkit-validator image. It reads the launch envelope,
// waits for the execution scope from the access sidecar (the only process
// of the Pod with a network identity), runs the chain — complete source,
// protected build, independent certification — on the reviewed fixed
// component baked into the image, moves the verified bytes through the
// sidecar's transfer route (BeginTransfer, one PUT, FinalizeTransfer under
// the current instance) and submits the result manifest naming the
// finalized handles (AcceptResult under the current epoch), then submits
// the same bytes once more to record that acceptance is idempotent. The
// candidate-content steps run under the candidate identity through
// setpriv; this process never imports candidate modules.
//
// Exit 0 when the trusted flow completed (whatever the verdict), 1 when it
// could not (no scope, no authority, a refused submission, a toolchain the
// profile does not freeze), 2 for a configuration or layout defect.
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { BuildError, type BuildOutput, buildComponent } from "./build.js";
import { jobsSchemaId, parseStrictObject, validateAgainst } from "./contracts.js";
import { sha256 } from "./digest.js";
import { InputError, unpackSourceArchive } from "./input.js";
import type { StepIdentity } from "./isolation.js";
import { loadProfiles, ProfileError, type Profiles, packageRoot, verifyToolchain } from "./profiles.js";
import { readSource, SourceError, type SourceRead } from "./source.js";
import { type Certification, certify, type FailureCode, verdictFor } from "./validate.js";

export interface JobConfig {
	paths: { workspace: string; verdict: string; sockets: string; termination_log: string; fixed_source: string };
	candidate: { identity: "setpriv" | "caller"; uid: number; gid: number };
	sidecar: { uid: number; wait_ms: number; request_timeout_ms: number };
	observer: { identity: string };
	host_checks: { ssr: boolean; browser: boolean };
	source_revision: string;
	validator_profile: string;
}

interface Envelope {
	schemaVersion: 1;
	launchId: string;
	launchKey: string;
	operationId: string;
	attemptId: string;
	profileId: string;
	profileRevision: string;
	jobKind: string;
	executionEpoch: string;
	launchEpoch: string;
	deadline: string;
	inputs: Array<{ name: string; digest: string; handle?: string }>;
}

interface Scope {
	tenantId: string;
	operationId: string;
	attemptId: string;
	instanceId: string;
	current: boolean;
	profileId: string;
	executionEpoch: string;
	launchKey: string;
	deadline: string;
}

interface Transfer {
	handle: string;
	transferId: string;
	class: string;
	digest: string;
	sizeBytes: string;
	objectVersion: string;
	state: string;
	existing: boolean;
}

interface Stage {
	stageId: string;
	resultDigest: string;
	existing: boolean;
}

/** What the Job leaves in the termination message: identities and outcomes, no candidate bytes. */
export interface Summary {
	outcome: "completed" | "infrastructure_failed" | "canceled";
	verdict?: string;
	failureCode?: string;
	stageId?: string;
	handles?: Record<string, string[]>;
	duplicateSubmission?: { existing: boolean; sameStage: boolean };
	stepIdentity?: string;
	/** Whether every mandatory check of the validator profile passed in this run (certified verdicts only). */
	complete?: boolean;
	evidenceDigest?: string;
	/** The chain's own refusal message under a failed verdict (this code's text, never candidate output). */
	detail?: string;
	error?: string;
}

class SidecarError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		reason: string,
	) {
		super(`sidecar answered ${status} ${code} ${reason}`);
	}
}

function loadConfig(): JobConfig {
	const file = process.env.ANVILKIT_VALIDATOR_CONFIG ?? "/etc/anvilkit/anvilkit-validator/config.yaml";
	const doc = parseYaml(readFileSync(file, "utf8"), { uniqueKeys: true }) as Partial<JobConfig>;
	const c: JobConfig = {
		paths: {
			workspace: "/workspace",
			verdict: "/anvilkit/verdict",
			sockets: "/run/anvilkit/sockets",
			termination_log: "/dev/termination-log",
			fixed_source: path.join(packageRoot, "fixtures", "component", "hero"),
			...(doc.paths ?? {}),
		},
		candidate: { identity: "setpriv", uid: 10001, gid: 10001, ...(doc.candidate ?? {}) },
		sidecar: { uid: 10002, wait_ms: 60_000, request_timeout_ms: 60_000, ...(doc.sidecar ?? {}) },
		observer: { identity: "anvilkit-validator-supervisor", ...(doc.observer ?? {}) },
		host_checks: { ssr: true, browser: true, ...(doc.host_checks ?? {}) },
		source_revision: doc.source_revision ?? "1",
		validator_profile: doc.validator_profile ?? "validator-dev-v1",
	};
	for (const k of ["launch_id", "attempt_id", "launch_envelope"]) {
		if (k in (doc as Record<string, unknown>))
			throw new Error(`config: ${k} is a launch fact and is refused inside the file`);
	}
	return c;
}

function parseEnvelope(raw: string): Envelope {
	const doc = parseStrictObject(raw, "launch envelope");
	const shape = validateAgainst(`${jobsSchemaId}#/$defs/launchEnvelope`, doc);
	if (shape) throw new Error(`launch envelope: ${shape}`);
	return doc as unknown as Envelope;
}

class Sidecar {
	constructor(
		private readonly socket: string,
		private readonly timeoutMs: number,
	) {}

	/** The DD-03 layout of the sockets directory and the trusted socket, verified before anything is sent. */
	verifyLayout(sidecarUID: number): void {
		const dir = path.dirname(this.socket);
		const d = lstatSync(dir);
		if (!d.isDirectory() || d.uid !== sidecarUID || d.gid !== 0 || (d.mode & 0o777) !== 0o711) {
			throw new Error(`${dir} is ${d.uid}:${d.gid} ${(d.mode & 0o777).toString(8)}, expected ${sidecarUID}:0 711`);
		}
		const s = lstatSync(this.socket);
		if (!s.isSocket() || s.uid !== sidecarUID || s.gid !== 0 || (s.mode & 0o777) !== 0o660) {
			throw new Error(
				`${this.socket} is ${s.uid}:${s.gid} ${(s.mode & 0o777).toString(8)}, expected a ${sidecarUID}:0 660 socket`,
			);
		}
	}

	async waitFor(ms: number): Promise<void> {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			try {
				if (lstatSync(this.socket).isSocket()) return;
			} catch {
				// not yet
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`trusted socket ${this.socket} did not appear within ${ms} ms`);
	}

	request<T>(method: string, route: string, headers: Record<string, string>, body?: Buffer): Promise<T> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					socketPath: this.socket,
					method,
					path: route,
					headers: { ...headers, connection: "close", ...(body ? { "content-length": String(body.byteLength) } : {}) },
					timeout: this.timeoutMs,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const raw = Buffer.concat(chunks).toString("utf8");
						if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) > 299) {
							let code = "";
							let reason = "";
							try {
								const e = JSON.parse(raw) as { code?: string; reason?: string };
								code = e.code ?? "";
								reason = e.reason ?? "";
							} catch {
								// no body
							}
							reject(new SidecarError(res.statusCode ?? 0, code, reason));
							return;
						}
						try {
							resolve((raw ? JSON.parse(raw) : {}) as T);
						} catch (err) {
							reject(err);
						}
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error(`sidecar ${method} ${route}: timeout`)));
			req.on("error", (err) => reject(new Error(`sidecar ${method} ${route}: ${err.message}`)));
			if (body) req.write(body);
			req.end();
		});
	}

	async awaitScope(deadline: Date, log: (m: string) => void): Promise<Scope> {
		for (;;) {
			try {
				const a = await this.request<{ scope: Scope }>("GET", "/v1/scope", {});
				return a.scope;
			} catch (err) {
				if (err instanceof SidecarError && err.code !== "SCOPE_UNAVAILABLE" && err.code !== "DEPENDENCY_UNAVAILABLE")
					throw err;
				log(`waiting for the execution scope: ${(err as Error).message}`);
				if (Date.now() + 2_000 > deadline.getTime())
					throw new Error(`scope not resolved before the deadline (last: ${(err as Error).message})`);
				await new Promise((r) => setTimeout(r, 2_000));
			}
		}
	}

	/** Asks the sidecar to load a handle-bound input through Control and stage it (P13-04). */
	loadInput(name: string): Promise<{ name: string; class: string; digest: string; sizeBytes: number }> {
		return this.request("POST", `/v1/inputs/${name}/loads`, {});
	}

	/** Reads the staged bytes of an input from the trusted socket. */
	readInput(name: string, maxBytes: number): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					socketPath: this.socket,
					method: "GET",
					path: `/v1/inputs/${name}`,
					headers: { connection: "close" },
					timeout: this.timeoutMs,
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (c: Buffer) => {
						size += c.length;
						if (size <= maxBytes + 1) chunks.push(c);
					});
					res.on("end", () => {
						if ((res.statusCode ?? 0) !== 200) {
							let code = "";
							try {
								code = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: string }).code ?? "";
							} catch {
								// no body
							}
							reject(new SidecarError(res.statusCode ?? 0, code, ""));
							return;
						}
						if (size > maxBytes) {
							reject(new Error(`input ${name} exceeds ${maxBytes} bytes`));
							return;
						}
						resolve(Buffer.concat(chunks));
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error(`sidecar GET /v1/inputs/${name}: timeout`)));
			req.on("error", (err) => reject(new Error(`sidecar GET /v1/inputs/${name}: ${err.message}`)));
			req.end();
		});
	}

	upload(cls: string, mediaType: string, body: Buffer): Promise<Transfer> {
		return this.request<Transfer>(
			"POST",
			"/v1/transfers",
			{ "x-anvilkit-class": cls, "content-type": mediaType },
			body,
		);
	}

	submit(verdict: string, failureCode: string, observer: string, manifest: Buffer): Promise<Stage> {
		const body = Buffer.from(
			JSON.stringify({
				verdict,
				failureCode,
				observerIdentity: observer,
				manifest: JSON.parse(manifest.toString("utf8")),
			}),
		);
		return this.request<Stage>("POST", "/v1/results", { "content-type": "application/json" }, body);
	}
}

interface Outcome {
	verdict: string;
	failureCode?: FailureCode;
	certification?: Certification;
	source?: SourceRead;
	build?: BuildOutput;
	error?: string;
}

/** The chain on the fixed source; every refusal becomes a verdict, never an exception past this point. */
async function runChain(
	cfg: JobConfig,
	profiles: Profiles,
	toolchain: Record<string, string>,
	identity: StepIdentity,
	workDir: string,
	sourceDir: string,
): Promise<Outcome> {
	let source: SourceRead;
	try {
		source = readSource(sourceDir, {
			sourceRevision: cfg.source_revision,
			profile: profiles.build,
			limits: profiles.validator.limits,
		});
	} catch (err) {
		if (err instanceof SourceError)
			return { verdict: verdictFor(profiles, err.code), failureCode: err.code, error: err.message };
		throw err;
	}
	let build: BuildOutput;
	try {
		build = await buildComponent(source, profiles, workDir, { identity });
	} catch (err) {
		if (err instanceof BuildError)
			return {
				verdict: verdictFor(profiles, err.code),
				failureCode: err.code,
				source,
				error: `${err.message}${err.details.length ? `: ${err.details.join(" | ").slice(0, 2000)}` : ""}`,
			};
		throw err;
	}
	const certification = await certify({ source, build, profiles, toolchain, identity, hostChecks: cfg.host_checks });
	return { verdict: certification.verdict, failureCode: certification.failureCode, certification, source, build };
}

/** The result manifest of the jobs contract for a verdict with the given outputs. */
function resultManifest(env: Envelope, verdict: string, failureCode: string, outputs: unknown[]): Buffer {
	const manifest: Record<string, unknown> = {
		schemaVersion: 1,
		launchId: env.launchId,
		attemptId: env.attemptId,
		jobKind: env.jobKind,
		profileId: env.profileId,
		verdict,
		outputs,
		completedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	};
	if (failureCode) manifest.failureCode = failureCode;
	const shape = validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, manifest);
	if (shape) throw new Error(`result manifest does not satisfy the contract: ${shape}`);
	return Buffer.from(JSON.stringify(manifest));
}

export async function main(): Promise<number> {
	const summary: Summary = { outcome: "infrastructure_failed" };
	const log = (m: string) => console.error(`[anvilkit-validator] ${m}`);
	let cfg: JobConfig | undefined;
	const terminate = () => {
		try {
			if (cfg) writeFileSync(cfg.paths.termination_log, JSON.stringify(summary));
		} catch {
			// the termination log is a best effort
		}
	};
	try {
		cfg = loadConfig();
		const launchID = process.env.ANVILKIT_LAUNCH_ID ?? "";
		const attemptID = process.env.ANVILKIT_ATTEMPT_ID ?? "";
		const rawEnvelope = process.env.ANVILKIT_LAUNCH_ENVELOPE ?? "";
		if (!launchID || !attemptID || !rawEnvelope)
			throw new Error("ANVILKIT_LAUNCH_ID, ANVILKIT_ATTEMPT_ID and ANVILKIT_LAUNCH_ENVELOPE are required");
		const env = parseEnvelope(rawEnvelope);
		if (env.launchId !== launchID || env.attemptId !== attemptID)
			throw new Error(
				`launch envelope names ${env.launchId}/${env.attemptId}, the launch environment ${launchID}/${attemptID}`,
			);
		if (env.jobKind !== "validator")
			throw new Error(`launch envelope is a ${env.jobKind} launch, this is the validator image`);
		const deadline = new Date(env.deadline);
		if (!(deadline.getTime() > Date.now())) throw new Error("the launch deadline has passed; nothing runs");
		if (process.getuid?.() !== 0 && cfg.candidate.identity === "setpriv")
			throw new Error("setpriv identity needs the supervisor to run as UID 0");

		// Layout: the verdict tree is closed to everyone but this process;
		// anything of an earlier run of this launch identity is stale.
		for (const dir of [cfg.paths.workspace, cfg.paths.verdict]) {
			const st = statSync(dir);
			if (!st.isDirectory()) throw new Error(`${dir} is not a mounted directory`);
		}
		chmodSync(cfg.paths.verdict, 0o700);
		const workDir = path.join(cfg.paths.workspace, "w");
		rmSync(workDir, { recursive: true, force: true });
		mkdirSync(workDir, { mode: 0o755 });

		const sidecar = new Sidecar(path.join(cfg.paths.sockets, "trusted.sock"), cfg.sidecar.request_timeout_ms);
		await sidecar.waitFor(Math.min(cfg.sidecar.wait_ms, Math.max(1_000, deadline.getTime() - Date.now())));
		sidecar.verifyLayout(cfg.sidecar.uid);
		const scope = await sidecar.awaitScope(deadline, log);
		if (
			scope.attemptId !== env.attemptId ||
			scope.operationId !== env.operationId ||
			scope.profileId !== env.profileId ||
			scope.launchKey !== env.launchKey
		) {
			throw new Error(
				`execution scope (${scope.operationId}/${scope.attemptId}/${scope.profileId}/${scope.launchKey}) does not match the launch envelope`,
			);
		}
		log(`execution scope granted: instance ${scope.instanceId}, attempt ${scope.attemptId}`);

		// The profiles and the toolchain: a difference is not a source
		// defect and nothing is built under it.
		let profiles: Profiles;
		let toolchain: Record<string, string>;
		try {
			profiles = loadProfiles(cfg.validator_profile);
			toolchain = verifyToolchain(profiles);
		} catch (err) {
			if (err instanceof ProfileError) throw new Error(`profile: ${err.message}`);
			throw err;
		}
		// The reviewed configuration cannot skip a check the profile names as
		// mandatory: such a Job could never certify, and a diagnostic run is
		// the local CLI's, never a launch's.
		for (const [check, enabled] of [
			["ssr-render", cfg.host_checks.ssr],
			["browser-host", cfg.host_checks.browser],
		] as const) {
			if (!enabled && profiles.validator.checks.includes(check))
				throw new Error(`config: host_checks disables ${check}, a mandatory check of ${profiles.validator.profileId}`);
		}
		const identity: StepIdentity =
			cfg.candidate.identity === "setpriv"
				? { mode: "setpriv", uid: cfg.candidate.uid, gid: cfg.candidate.gid }
				: { mode: "caller" };
		summary.stepIdentity = identity.mode;

		// The source: the archive the envelope binds by handle (loaded by
		// the sidecar from Control's accepted stage, verified against the
		// envelope's digest, unpacked under the source rules) or, for the
		// fixed development profile, the reviewed component of the image.
		let sourceDir = cfg.paths.fixed_source;
		const sourceInput = env.inputs.find((i) => i.name === "source" && i.handle);
		if (sourceInput) {
			const loaded = await sidecar.loadInput("source");
			const archive = await sidecar.readInput("source", profiles.validator.limits.maxSourceBytes * 2 + 1_048_576);
			if (sha256(archive) !== sourceInput.digest || loaded.digest !== sourceInput.digest)
				throw new Error(
					`the loaded source hashes to ${sha256(archive)} (sidecar: ${loaded.digest}), the envelope binds ${sourceInput.digest}`,
				);
			sourceDir = path.join(cfg.paths.workspace, "input-source");
			rmSync(sourceDir, { recursive: true, force: true });
			try {
				const files = await unpackSourceArchive(archive, sourceDir, profiles.validator.limits);
				log(`source input unpacked: ${files.length} files`);
			} catch (err) {
				if (err instanceof InputError) {
					summary.verdict = "invalid";
					summary.failureCode = "PATH_ESCAPE";
					summary.detail = err.message.slice(0, 300);
					writeFileSync(
						path.join(cfg.paths.verdict, "verdict.json"),
						`${JSON.stringify({ verdict: "invalid", failureCode: "PATH_ESCAPE" })}\n`,
						{ mode: 0o600 },
					);
					const manifest = resultManifest(env, "invalid", "PATH_ESCAPE", []);
					const stage = await sidecar.submit("invalid", "PATH_ESCAPE", cfg.observer.identity, manifest);
					summary.outcome = "completed";
					summary.stageId = stage.stageId;
					log(`source input refused: ${err.message}; result accepted as stage ${stage.stageId}`);
					return 0;
				}
				throw err;
			}
		}
		const outcome = await runChain(cfg, profiles, toolchain, identity, workDir, sourceDir);
		summary.verdict = outcome.verdict;
		summary.failureCode = outcome.failureCode;
		if (outcome.certification) summary.complete = outcome.certification.complete;
		if (outcome.error) summary.detail = outcome.error.split("\n")[0]?.slice(0, 300);
		if (outcome.certification && outcome.verdict !== "certified") {
			summary.detail = outcome.certification.checks
				.filter((c) => c.status === "fail")
				.map((c) => `${c.name}: ${c.detail ?? ""}`)
				.join("; ")
				.slice(0, 300);
		}
		writeFileSync(
			path.join(cfg.paths.verdict, "verdict.json"),
			`${JSON.stringify({ verdict: outcome.verdict, failureCode: outcome.failureCode ?? "" })}\n`,
			{ mode: 0o600 },
		);

		// The finalizer: verified bytes first (artifacts only under a
		// certified verdict), then the evidence, then the manifest naming
		// the finalized handles.
		const outputs: Array<{ class: string; digest: string; sizeBytes: string; handle: string }> = [];
		const handles: Record<string, string[]> = {};
		const record = (t: Transfer) => {
			outputs.push({ class: t.class, digest: t.digest, sizeBytes: t.sizeBytes, handle: t.handle });
			const list = handles[t.class] ?? [];
			list.push(t.handle);
			handles[t.class] = list;
		};
		const build = outcome.build;
		if (outcome.verdict === "certified" && build && outcome.certification) {
			const c = outcome.certification;
			if (!c.complete) throw new Error("a certified verdict without a complete run; nothing is uploaded");
			const npmBytes = readFileSync(build.npm.file);
			if (sha256(npmBytes) !== c.bindings.npm.digest) throw new Error("npm tarball changed after certification");
			record(await sidecar.upload("npm", "application/gzip", npmBytes));
			const browserBytes = readFileSync(build.browser.file);
			if (sha256(browserBytes) !== c.bindings.browser.digest)
				throw new Error("browser module changed after certification");
			record(await sidecar.upload("browser", "text/javascript", browserBytes));
			for (const css of build.css) {
				const bytes = readFileSync(css.file);
				// The certification binds a stylesheet by its source path; the build lists it under dist/.
				const bound = c.bindings.css.find((b) => `dist/${b.path}` === css.path);
				if (!bound || sha256(bytes) !== bound.digest) throw new Error(`${css.path} changed after certification`);
				record(await sidecar.upload("css", "text/css", bytes));
			}
		}
		const evidence = {
			schemaVersion: 1,
			launchId: env.launchId,
			attemptId: env.attemptId,
			profileId: env.profileId,
			validatorProfileId: profiles.validator.profileId,
			verdict: outcome.verdict,
			...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
			...(outcome.error ? { error: outcome.error } : {}),
			...(outcome.source
				? {
						sourceDigest: outcome.source.manifest.manifestDigest,
						sourceRevision: outcome.source.manifest.sourceRevision,
					}
				: {}),
			certification: outcome.certification ?? null,
			toolchain,
			stepIdentity: identity.mode,
		};
		const evidenceBytes = Buffer.from(JSON.stringify(evidence));
		writeFileSync(path.join(cfg.paths.verdict, "evidence.json"), evidenceBytes, { mode: 0o600 });
		summary.evidenceDigest = outcome.certification?.evidenceDigest ?? sha256(evidenceBytes);
		record(await sidecar.upload("evidence", "application/json", evidenceBytes));
		summary.handles = handles;
		const manifestBytes = resultManifest(env, outcome.verdict, outcome.failureCode ?? "", outputs);
		writeFileSync(path.join(cfg.paths.verdict, "manifest.json"), manifestBytes, { mode: 0o600 });
		const stage = await sidecar.submit(
			outcome.verdict,
			outcome.failureCode ?? "",
			cfg.observer.identity,
			manifestBytes,
		);
		summary.stageId = stage.stageId;
		const repeat = await sidecar.submit(
			outcome.verdict,
			outcome.failureCode ?? "",
			cfg.observer.identity,
			manifestBytes,
		);
		summary.duplicateSubmission = { existing: repeat.existing, sameStage: repeat.stageId === stage.stageId };
		summary.outcome = "completed";
		log(
			`result accepted: stage ${stage.stageId}, verdict ${outcome.verdict}, duplicate reentered ${repeat.existing && repeat.stageId === stage.stageId}`,
		);
		terminate();
		return 0;
	} catch (err) {
		summary.error = String((err as Error).message ?? err);
		log(`trusted flow did not complete: ${summary.error}`);
		terminate();
		return cfg ? 1 : 2;
	}
}

if (process.argv[1] && (process.argv[1].endsWith("/job.js") || process.argv[1].endsWith("/job.ts"))) {
	main().then((code) => process.exit(code));
}
