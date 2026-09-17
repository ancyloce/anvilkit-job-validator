// Local reproduction entry (no Job, no sidecar): the same trusted chain the
// Job runs — read the complete source, build under the profile, certify —
// with the artifacts and the certification written to a directory.
//
//   pnpm certify <sourceDir> --source-revision <n> --out <dir> [--no-browser] [--no-ssr] [--validator-profile <id>] [--step-identity setpriv]
//
// --step-identity setpriv runs the build, SSR and browser steps as UID/GID
// 10001 through setpriv, as the Job does (a root caller is required); the
// default runs them as the caller. --no-ssr and --no-browser skip a host
// check for a diagnostic run: the validator profile names them as
// mandatory, so such a run is never "certified" (its verdict is
// infrastructure_failed/OBSERVER_FAILED with the skipped checks not_run and
// complete: false) and is never reusable as a certification. Exit 0 when
// the chain completed (whatever the verdict; the verdict is in the
// certification), 1 when the source contract or the build refused (their
// code and message are printed as JSON), 2 for a usage or profile problem.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BuildError, buildComponent } from "./build.js";
import { callerIdentity, type StepIdentity } from "./isolation.js";
import { loadProfiles, ProfileError, verifyToolchain } from "./profiles.js";
import { readSource, SourceError } from "./source.js";
import { certify } from "./validate.js";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
	const sourceDir = process.argv[2];
	const out = arg("--out");
	const sourceRevision = arg("--source-revision") ?? "1";
	if (!sourceDir || sourceDir.startsWith("--") || !out) {
		console.error(
			"usage: certify <sourceDir> --source-revision <n> --out <dir> [--no-browser] [--no-ssr] [--validator-profile <id>]",
		);
		return 2;
	}
	let profiles: ReturnType<typeof loadProfiles>;
	let toolchain: Record<string, string>;
	try {
		profiles = loadProfiles(arg("--validator-profile"));
		toolchain = verifyToolchain(profiles);
	} catch (err) {
		console.error(
			JSON.stringify({
				code: err instanceof ProfileError ? err.code : "PROFILE_UNQUALIFIED",
				message: (err as Error).message,
			}),
		);
		return 2;
	}
	const identity: StepIdentity =
		arg("--step-identity") === "setpriv" ? { mode: "setpriv", uid: 10001, gid: 10001 } : callerIdentity();
	mkdirSync(out, { recursive: true });
	const workDir = path.join(out, "work");
	try {
		const source = readSource(sourceDir, {
			sourceRevision,
			profile: profiles.build,
			limits: profiles.validator.limits,
		});
		writeFileSync(path.join(out, "source-manifest.json"), `${JSON.stringify(source.manifest, null, 2)}\n`);
		const build = await buildComponent(source, profiles, workDir, { identity });
		const hostChecks = { ssr: !process.argv.includes("--no-ssr"), browser: !process.argv.includes("--no-browser") };
		if (!hostChecks.ssr || !hostChecks.browser) {
			console.error(
				"diagnostic run: a mandatory host check is skipped; the result is not a certification and cannot be reused as one",
			);
		}
		const cert = await certify({ source, build, profiles, toolchain, identity, hostChecks });
		const artifacts = path.join(out, "artifacts");
		mkdirSync(artifacts, { recursive: true });
		cpSync(build.npm.file, path.join(artifacts, path.basename(build.npm.file)));
		cpSync(build.browser.file, path.join(artifacts, "index.js"));
		for (const c of build.css) cpSync(c.file, path.join(artifacts, path.basename(c.path)));
		writeFileSync(path.join(out, "certification.json"), `${JSON.stringify(cert, null, 2)}\n`);
		console.log(
			JSON.stringify({
				verdict: cert.verdict,
				failureCode: cert.failureCode,
				complete: cert.complete,
				evidenceDigest: cert.evidenceDigest,
				npm: cert.bindings.npm,
				browser: cert.bindings.browser,
				css: cert.bindings.css,
				failed: cert.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`),
			}),
		);
		return 0;
	} catch (err) {
		if (err instanceof SourceError || err instanceof BuildError) {
			console.error(
				JSON.stringify({
					code: err.code,
					message: err.message,
					details: err instanceof BuildError ? err.details : undefined,
				}),
			);
			return 1;
		}
		throw err;
	}
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err);
		process.exit(2);
	},
);
