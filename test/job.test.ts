import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";
import { contractsDir } from "../src/contracts.js";
import { type Envelope, jobProfile, LaunchRefusal, main, type SourceSelection, selectSource } from "../src/job.js";
import { heroSource, rootGate } from "./helpers.js";

const scratch: string[] = [];
function dir(prefix: string): string {
	const d = mkdtempSync(path.join(tmpdir(), prefix));
	scratch.push(d);
	return d;
}
afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const digest = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const hero = { componentId: "cmp_hero_fixed", puckType: "Hero", packageName: "@anvilkit/hero-fixed" };
const sourceInput = { name: "source", digest: `sha256:${"1".repeat(64)}`, handle: "hdl_source" };

describe("the launch's own Job profile (contracts/jobs/profiles.json)", () => {
	it("resolves the validator profiles and what they bind", () => {
		expect(jobProfile("validator-fixture-v1")).toEqual({
			profileId: "validator-fixture-v1",
			candidateCode: false,
			bindsSource: false,
		});
		expect(jobProfile("validator-source-v1")).toEqual({
			profileId: "validator-source-v1",
			candidateCode: true,
			bindsSource: true,
		});
		expect(jobProfile("validator-source-dev-v1")).toEqual({
			profileId: "validator-source-dev-v1",
			candidateCode: true,
			bindsSource: true,
		});
		// The retired id, an unknown id and another Job kind are refusals of the launch.
		for (const id of ["validator-fixed-dev-v1", "validator-unknown", "codegen-fixed-v1"])
			expect(() => jobProfile(id), id).toThrow(LaunchRefusal);
	});

	it("reads the image's projection of the document (no image digests) the same way", () => {
		const full = JSON.parse(readFileSync(path.join(contractsDir(), "jobs", "profiles.json"), "utf8")) as {
			schemaVersion: number;
			profiles: Array<Record<string, unknown>>;
		};
		const projection = {
			schemaVersion: full.schemaVersion,
			profiles: full.profiles
				.filter((p) => p.jobKind === "validator")
				.map(({ profileId, jobKind, candidateCode, bindsSource }) => ({
					profileId,
					jobKind,
					candidateCode,
					...(bindsSource === undefined ? {} : { bindsSource }),
				})),
		};
		const file = path.join(dir("anvilkit-job-"), "profiles.json");
		writeFileSync(file, JSON.stringify(projection));
		expect(jobProfile("validator-source-dev-v1", file)).toEqual(jobProfile("validator-source-dev-v1"));
		expect(jobProfile("validator-fixture-v1", file)).toEqual(jobProfile("validator-fixture-v1"));
		// A profile that would bind source without declaring candidate code is refused.
		writeFileSync(
			file,
			JSON.stringify({
				schemaVersion: 1,
				profiles: [{ profileId: "validator-x", jobKind: "validator", candidateCode: false, bindsSource: true }],
			}),
		);
		expect(() => jobProfile("validator-x", file)).toThrow(/binds source without declaring candidate code/);
	});
});

describe("the bound-source rule (B-21)", () => {
	const fixture = jobProfile("validator-fixture-v1");
	const bound = jobProfile("validator-source-dev-v1");
	const component = { ...hero, sourceRevision: "42" };
	const refused = (env: Pick<Envelope, "inputs" | "component">, profile = bound): string => {
		try {
			selectSource(env, profile);
		} catch (err) {
			expect(err).toBeInstanceOf(LaunchRefusal);
			expect((err as LaunchRefusal).code).toBe("PROFILE_UNQUALIFIED");
			return (err as Error).message;
		}
		throw new Error("not refused");
	};

	it("runs the fixed component only under a profile that does not bind source", () => {
		expect(selectSource({ inputs: [] }, fixture)).toEqual<SourceSelection>({ kind: "fixed" });
		expect(refused({ inputs: [sourceInput] }, fixture)).toMatch(/runs the fixed component only/);
		// Even without a handle, a source input is refused there.
		expect(refused({ inputs: [{ name: "source", digest: sourceInput.digest }] }, fixture)).toMatch(
			/refuses a source input/,
		);
	});

	it("requires a handle-bound source and its source revision under a profile that binds source", () => {
		expect(selectSource({ inputs: [sourceInput], component }, bound)).toEqual<SourceSelection>({
			kind: "bound",
			digest: sourceInput.digest,
			handle: sourceInput.handle,
			component,
		});
		// No silent fallback to the fixed Hero.
		expect(refused({ inputs: [], component })).toMatch(/names none \(no fallback to the fixed component\)/);
		expect(refused({ inputs: [{ name: "source", digest: sourceInput.digest }], component })).toMatch(/has no handle/);
		expect(refused({ inputs: [sourceInput] })).toMatch(/names no source revision/);
		// A preview or release launch names the revision alone (no allocated identity is recorded for a lineage).
		expect(selectSource({ inputs: [sourceInput], component: { sourceRevision: "5" } }, bound)).toMatchObject({
			kind: "bound",
			component: { sourceRevision: "5" },
		});
		expect(refused({ inputs: [sourceInput, { ...sourceInput, handle: "hdl_other" }], component })).toMatch(
			/more than once/,
		);
	});
});

// The Job end to end against a fake access sidecar on its trusted socket
// (root only: the socket layout the Job verifies is owned by the sidecar's
// UID and group 0). The chain runs as the caller.
const gate = rootGate([]);

interface Sidecar {
	socketDir: string;
	loads: number;
	transfers: Array<{ class: string; body: Buffer }>;
	results: Array<{ verdict: string; failureCode: string; manifest: Record<string, unknown> }>;
	close: () => Promise<void>;
}

async function fakeSidecar(root: string, env: Envelope, archive: Buffer): Promise<Sidecar> {
	const socketDir = path.join(root, "sockets");
	mkdirSync(socketDir);
	const socket = path.join(socketDir, "trusted.sock");
	const state: Sidecar = { socketDir, loads: 0, transfers: [], results: [], close: async () => {} };
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const json = (status: number, value: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (req.method === "GET" && req.url === "/v1/scope") {
				json(200, {
					scope: {
						tenantId: "ten_1",
						operationId: env.operationId,
						attemptId: env.attemptId,
						instanceId: "ins_1",
						current: true,
						profileId: env.profileId,
						executionEpoch: env.executionEpoch,
						launchKey: env.launchKey,
						deadline: env.deadline,
					},
				});
			} else if (req.method === "POST" && req.url === "/v1/inputs/source/loads") {
				state.loads++;
				json(200, { name: "source", class: "source", digest: digest(archive), sizeBytes: archive.length });
			} else if (req.method === "GET" && req.url === "/v1/inputs/source") {
				res.writeHead(200, { "content-type": "application/octet-stream" });
				res.end(archive);
			} else if (req.method === "POST" && req.url === "/v1/transfers") {
				const cls = String(req.headers["x-anvilkit-class"]);
				state.transfers.push({ class: cls, body });
				json(200, {
					handle: `hdl_${cls}_${state.transfers.length}`,
					transferId: `trf_${state.transfers.length}`,
					class: cls,
					digest: digest(body),
					sizeBytes: String(body.length),
					objectVersion: "1",
					state: "FINALIZED",
					existing: false,
				});
			} else if (req.method === "POST" && req.url === "/v1/results") {
				state.results.push(JSON.parse(body.toString("utf8")));
				json(200, { stageId: "stg_1", resultDigest: digest(body), existing: state.results.length > 1 });
			} else {
				json(404, { code: "NOT_FOUND", reason: `${req.method} ${req.url}` });
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	// The DD-03 layout the Job verifies before it sends anything.
	chownSync(socketDir, 10002, 0);
	chmodSync(socketDir, 0o711);
	chownSync(socket, 10002, 0);
	chmodSync(socket, 0o660);
	state.close = () => new Promise((resolve) => server.close(() => resolve()));
	return state;
}

async function heroArchive(): Promise<Buffer> {
	const files: string[] = [];
	const walk = (d: string, rel = "") => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(d, e.name), p);
			else files.push(p);
		}
	};
	walk(heroSource);
	const file = path.join(dir("anvilkit-job-archive-"), "source.tar");
	await tar.create({ portable: true, cwd: heroSource, file, follow: false, noDirRecurse: true }, files.sort());
	return readFileSync(file);
}

/** Runs the Job's main() once for a launch; returns the exit code, the termination summary and what the sidecar saw. */
async function runJob(
	launch: Partial<Envelope>,
	archive: Buffer,
): Promise<{ code: number; summary: Record<string, unknown>; sidecar: Sidecar }> {
	const root = dir("anvilkit-job-");
	chmodSync(root, 0o755);
	for (const d of ["workspace", "verdict"]) mkdirSync(path.join(root, d));
	const env: Envelope = {
		schemaVersion: 1,
		launchId: "lch_1",
		launchKey: "validator-p08",
		operationId: "op_1",
		attemptId: "att_1",
		profileId: "validator-source-dev-v1",
		profileRevision: "1",
		jobKind: "validator",
		executionEpoch: "1",
		launchEpoch: "1",
		deadline: new Date(Date.now() + 3_600_000).toISOString(),
		inputs: [],
		...launch,
	};
	const sidecar = await fakeSidecar(root, env, archive);
	const config = path.join(root, "config.yaml");
	writeFileSync(
		config,
		[
			"paths:",
			`  workspace: ${path.join(root, "workspace")}`,
			`  verdict: ${path.join(root, "verdict")}`,
			`  sockets: ${sidecar.socketDir}`,
			`  termination_log: ${path.join(root, "termination-log")}`,
			`  fixed_source: ${heroSource}`,
			"candidate:",
			"  identity: caller",
			"sidecar:",
			"  uid: 10002",
			"  wait_ms: 5000",
			"  request_timeout_ms: 60000",
			"",
		].join("\n"),
	);
	const saved = { ...process.env };
	Object.assign(process.env, {
		ANVILKIT_VALIDATOR_CONFIG: config,
		ANVILKIT_LAUNCH_ID: env.launchId,
		ANVILKIT_ATTEMPT_ID: env.attemptId,
		ANVILKIT_LAUNCH_ENVELOPE: JSON.stringify(env),
	});
	try {
		const code = await main();
		const summary = JSON.parse(readFileSync(path.join(root, "termination-log"), "utf8")) as Record<string, unknown>;
		return { code, summary, sidecar };
	} finally {
		process.env = saved;
		await sidecar.close();
	}
}

describe.skipIf(gate.skip)("the validator Job against a fake access sidecar", () => {
	it("refuses a launch its profile does not admit, before any source is loaded (PROFILE_UNQUALIFIED)", async () => {
		gate.assert();
		const archive = await heroArchive();
		const bound = { ...sourceInput, digest: digest(archive) };
		const component = { ...hero, sourceRevision: "42" };
		const launches: Array<[string, Partial<Envelope>]> = [
			["a source input under the fixture profile", { profileId: "validator-fixture-v1", inputs: [bound] }],
			["no source under a source-binding profile", { inputs: [], component }],
			["a source input without a handle", { inputs: [{ name: "source", digest: bound.digest }], component }],
			["a bound source without its source revision", { inputs: [bound] }],
		];
		for (const [what, launch] of launches) {
			const { code, summary, sidecar } = await runJob(launch, archive);
			expect(code, what).toBe(0);
			expect(summary.outcome, what).toBe("completed");
			expect(summary.failureCode, what).toBe("PROFILE_UNQUALIFIED");
			expect(sidecar.loads, what).toBe(0);
			expect(sidecar.transfers, what).toEqual([]);
			expect(
				sidecar.results.map((r) => [r.verdict, r.failureCode, r.manifest.verdict, r.manifest.failureCode]),
			).toEqual([["infrastructure_failed", "PROFILE_UNQUALIFIED", "infrastructure_failed", "PROFILE_UNQUALIFIED"]]);
		}
	});

	it("refuses a bound source whose puckType or package name is not the allocated identity (IDENTITY_MISMATCH)", async () => {
		gate.assert();
		const archive = await heroArchive();
		const bound = { ...sourceInput, digest: digest(archive) };
		for (const mismatch of [{ puckType: "Banner" }, { packageName: "@acme/hero" }]) {
			const { code, summary, sidecar } = await runJob(
				{ inputs: [bound], component: { ...hero, ...mismatch, sourceRevision: "42" } },
				archive,
			);
			expect(code).toBe(0);
			expect(summary.verdict).toBe("invalid");
			expect(summary.failureCode).toBe("IDENTITY_MISMATCH");
			expect(sidecar.loads).toBe(1);
			// Only the evidence is uploaded: nothing of a refused source is an artifact.
			expect(sidecar.transfers.map((t) => t.class)).toEqual(["evidence"]);
			expect(sidecar.results[0]?.manifest).toMatchObject({ verdict: "invalid", failureCode: "IDENTITY_MISMATCH" });
		}
	});

	it("certifies a bound source at the launch's source revision and identity, not the configured constant", async () => {
		gate.assert();
		const archive = await heroArchive();
		const { code, summary, sidecar } = await runJob(
			{ inputs: [{ ...sourceInput, digest: digest(archive) }], component: { ...hero, sourceRevision: "42" } },
			archive,
		);
		expect(code).toBe(0);
		expect(summary.verdict, String(summary.detail)).toBe("certified");
		expect(sidecar.loads).toBe(1);
		expect(sidecar.transfers.map((t) => t.class)).toEqual(["npm", "browser", "css", "evidence"]);
		const evidence = JSON.parse((sidecar.transfers.at(-1)?.body ?? Buffer.alloc(0)).toString("utf8")) as {
			sourceRevision: string;
			certification: { bindings: Record<string, unknown> };
		};
		expect(evidence.sourceRevision).toBe("42");
		expect(evidence.certification.bindings).toMatchObject({ ...hero, sourceRevision: "42" });
		expect(sidecar.results).toHaveLength(2);
		expect(sidecar.results[0]?.manifest).toMatchObject({ verdict: "certified", profileId: "validator-source-dev-v1" });
	});

	it("certifies a preview or release launch at its bound revision, the source's declaration naming the component", async () => {
		gate.assert();
		const archive = await heroArchive();
		const { code, summary, sidecar } = await runJob(
			{ inputs: [{ ...sourceInput, digest: digest(archive) }], component: { sourceRevision: "5" } },
			archive,
		);
		expect(code).toBe(0);
		expect(summary.verdict, String(summary.detail)).toBe("certified");
		const evidence = JSON.parse((sidecar.transfers.at(-1)?.body ?? Buffer.alloc(0)).toString("utf8")) as {
			sourceRevision: string;
			certification: { bindings: Record<string, unknown> };
		};
		expect(evidence.sourceRevision).toBe("5");
		expect(evidence.certification.bindings).toMatchObject({ ...hero, sourceRevision: "5" });
	});
});
