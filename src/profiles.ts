// Trusted profiles of the validator (DD-04 §1–§3). Three documents under
// profiles/, each carrying its own profileDigest over its canonical content:
//
//   build-support-<id>.json  the contract's buildSupportProfile: the frozen
//                            Node/pnpm/TypeScript/React/Puck versions, the
//                            allowed dependencies and the Host ABI id;
//   host-abi-<id>.json       the Host ABI the browser module is built for:
//                            module format, externals the host provides,
//                            the entry export contract, how CSS is loaded;
//   validator-<id>.json      the validator's own toolchain pins, the checks
//                            it runs, the verdict/failure-code mapping and
//                            the digests of its protected host fixtures.
//
// A profile whose digest does not match its content, or whose pinned
// toolchain is not what this process runs, is refused: nothing is built or
// certified under a profile the code cannot vouch for. Every profile here is
// DEVELOPMENT_ONLY until real Studio host evidence (ENV-08) exists.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION as rollupVersion } from "rollup";
import { version as typescriptVersion } from "typescript";
import { componentsSchemaId, parseStrictObject, validateAgainst } from "./contracts.js";
import { canonicalDigest, type Digest, digestPattern, sha256 } from "./digest.js";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const profilesDir = path.join(packageRoot, "profiles");

export interface BuildSupportProfile {
	schemaVersion: 1;
	profileId: string;
	revision: string;
	node: string;
	packageManager: string;
	typescript: string;
	react: string;
	puck: string;
	hostAbi: string;
	allowedDependencies: Record<string, string>;
	profileDigest: Digest;
}

export interface HostAbiProfile {
	schemaVersion: 1;
	hostAbi: string;
	status: "DEVELOPMENT_ONLY" | "QUALIFIED";
	evidence: string;
	moduleFormat: "esm";
	/** Bare specifiers the host provides through its import map, with the exact version it serves. */
	externals: Record<string, string>;
	entryExports: { default: "puck-component-config"; named: string[] };
	styles: "separate-css-loaded-before-import";
	profileDigest: Digest;
}

export type Verdict = "certified" | "repairable" | "invalid" | "infrastructure_failed" | "canceled";

export interface ValidatorProfile {
	schemaVersion: 1;
	profileId: string;
	revision: string;
	status: "DEVELOPMENT_ONLY" | "QUALIFIED";
	buildProfileId: string;
	hostAbi: string;
	toolchain: { rollup: string; rollupPluginTypescript: string; tslib: string; playwright: string };
	/** The mandatory checks: a certification is complete only when every one of them passed in the run. */
	checks: string[];
	verdicts: Record<Exclude<Verdict, "certified">, string[]>;
	protectedFixtures: Record<string, Digest>;
	limits: {
		maxSourceFiles: number;
		maxSourceFileBytes: number;
		maxSourceBytes: number;
		maxBrowserModuleBytes: number;
		maxNpmTarballBytes: number;
		maxCssBytes: number;
		buildTimeoutMs: number;
		hostCheckTimeoutMs: number;
	};
	profileDigest: Digest;
}

export interface Profiles {
	build: BuildSupportProfile;
	host: HostAbiProfile;
	validator: ValidatorProfile;
}

export class ProfileError extends Error {
	readonly code = "PROFILE_UNQUALIFIED";
}

/** The digest a profile document must carry: canonical JSON of everything but profileDigest. */
export function profileDigest(doc: Record<string, unknown>): Digest {
	const { profileDigest: _omitted, ...rest } = doc;
	return canonicalDigest(rest);
}

function readProfile(file: string): Record<string, unknown> {
	const doc = parseStrictObject(readFileSync(file, "utf8"), path.basename(file));
	const declared = doc.profileDigest;
	if (typeof declared !== "string" || !digestPattern.test(declared)) {
		throw new ProfileError(`${path.basename(file)}: profileDigest is missing`);
	}
	const actual = profileDigest(doc);
	if (declared !== actual) {
		throw new ProfileError(`${path.basename(file)}: profileDigest ${declared} does not match the content ${actual}`);
	}
	return doc;
}

/**
 * Loads the three profiles named by the validator profile id (default:
 * the one validator-*.json under profiles/), verifies every digest, the
 * contract shape of the build-support profile and the cross references.
 */
export function loadProfiles(validatorProfileId?: string, dir = profilesDir): Profiles {
	const names = readdirSync(dir).filter((n) => n.startsWith("validator-") && n.endsWith(".json"));
	const id = validatorProfileId ?? (names.length === 1 ? names[0]?.slice(0, -".json".length) : undefined);
	if (!id) throw new ProfileError(`profiles/: name the validator profile (found ${names.join(", ") || "none"})`);
	const validator = readProfile(path.join(dir, `${id}.json`)) as unknown as ValidatorProfile;
	if (validator.profileId !== id)
		throw new ProfileError(`${id}.json: profileId ${validator.profileId} does not match its file`);
	const build = readProfile(path.join(dir, `${validator.buildProfileId}.json`)) as unknown as BuildSupportProfile;
	const shape = validateAgainst(`${componentsSchemaId}#/$defs/buildSupportProfile`, build);
	if (shape) throw new ProfileError(`${validator.buildProfileId}.json is not a buildSupportProfile: ${shape}`);
	if (build.profileId !== validator.buildProfileId)
		throw new ProfileError(`${validator.buildProfileId}.json: profileId mismatch`);
	const host = readProfile(path.join(dir, `${build.hostAbi}.json`)) as unknown as HostAbiProfile;
	if (host.hostAbi !== build.hostAbi || validator.hostAbi !== build.hostAbi) {
		throw new ProfileError(`host ABI ${build.hostAbi} is not what the validator and build profiles bind`);
	}
	if (host.moduleFormat !== "esm" || host.styles !== "separate-css-loaded-before-import") {
		throw new ProfileError(`host ABI ${host.hostAbi}: unsupported module or style contract`);
	}
	for (const [name, version] of Object.entries(build.allowedDependencies)) {
		const external = host.externals[name];
		if (external !== undefined && external !== version) {
			throw new ProfileError(`allowed dependency ${name}@${version} is served by the host as ${external}`);
		}
	}
	if (host.externals.react !== build.react || host.externals["@puckeditor/core"] !== build.puck) {
		throw new ProfileError("the host ABI serves another React or Puck than the build profile freezes");
	}
	if (
		!Array.isArray(validator.checks) ||
		validator.checks.length === 0 ||
		new Set(validator.checks).size !== validator.checks.length
	) {
		throw new ProfileError(`${id}.json: checks must name the mandatory checks once each`);
	}
	for (const [rel, digest] of Object.entries(validator.protectedFixtures)) {
		if (!digestPattern.test(digest) || rel.includes("..") || path.isAbsolute(rel)) {
			throw new ProfileError(`protected fixture ${rel}: invalid entry`);
		}
	}
	return { build, host, validator };
}

/** Digest of the profile set a certification binds (build, host, validator). */
export function profileSetDigest(p: Profiles): Digest {
	return canonicalDigest({
		build: p.build.profileDigest,
		host: p.host.profileDigest,
		validator: p.validator.profileDigest,
	});
}

const require = createRequire(import.meta.url);

function installedVersion(pkg: string): string {
	// Packages may not export ./package.json; walk up from the resolved
	// entry to the package directory named by the specifier.
	let dir = path.dirname(require.resolve(pkg));
	const tail = path.join("node_modules", ...pkg.split("/"));
	while (!dir.endsWith(tail) && path.dirname(dir) !== dir) dir = path.dirname(dir);
	if (!dir.endsWith(tail))
		throw new ProfileError(`${pkg}: installed package directory not found from ${require.resolve(pkg)}`);
	return (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

/**
 * The actual toolchain of this process compared with the profile: Node,
 * pnpm, TypeScript, Rollup and its TypeScript plugin, tslib, the host's
 * React, ReactDOM and Puck, Playwright. A difference is PROFILE_UNQUALIFIED:
 * the profile freezes versions that were reviewed, and nothing is built
 * with others. Recorded versions and addresses in contract fixtures are not
 * evidence; this reads the installed packages.
 */
export function verifyToolchain(p: Profiles): Record<string, string> {
	// The package manager is not run here: the locked install happened when
	// the image (or the developer checkout) was installed, and a Job Pod has
	// no network for pnpm to reach. The pin is the packageManager field of
	// this package, the one the lockfile was produced with.
	const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { packageManager?: string };
	const actual: Record<string, string> = {
		node: process.versions.node,
		packageManager: pkg.packageManager ?? "",
		typescript: typescriptVersion,
		react: installedVersion("react"),
		reactDom: installedVersion("react-dom"),
		puck: installedVersion("@puckeditor/core"),
		rollup: rollupVersion,
		rollupPluginTypescript: installedVersion("@rollup/plugin-typescript"),
		tslib: installedVersion("tslib"),
		playwright: installedVersion("playwright"),
	};
	const expected: Record<string, string> = {
		node: p.build.node,
		packageManager: p.build.packageManager,
		typescript: p.build.typescript,
		react: p.build.react,
		reactDom: p.host.externals["react-dom"] ?? p.build.react,
		puck: p.build.puck,
		rollup: p.validator.toolchain.rollup,
		rollupPluginTypescript: p.validator.toolchain.rollupPluginTypescript,
		tslib: p.validator.toolchain.tslib,
		playwright: p.validator.toolchain.playwright,
	};
	for (const [k, want] of Object.entries(expected)) {
		if (actual[k] !== want) throw new ProfileError(`toolchain ${k} is ${actual[k]}, the profile freezes ${want}`);
	}
	return actual;
}

/** Digests of the protected host fixtures as they are on disk right now. */
export function protectedFixtureDigests(p: Profiles, root = packageRoot): Record<string, Digest> {
	const out: Record<string, Digest> = {};
	for (const rel of Object.keys(p.validator.protectedFixtures).sort()) {
		try {
			out[rel] = sha256(readFileSync(path.join(root, rel)));
		} catch {
			out[rel] = "sha256:missing" as Digest;
		}
	}
	return out;
}

/** True when every protected fixture on disk is what the validator profile pins. */
export function protectedFixturesIntact(p: Profiles, root = packageRoot): { intact: boolean; altered: string[] } {
	const now = protectedFixtureDigests(p, root);
	const altered = Object.entries(p.validator.protectedFixtures)
		.filter(([rel, digest]) => now[rel] !== digest)
		.map(([rel]) => rel);
	return { intact: altered.length === 0, altered };
}

// `tsx src/profiles.ts --check` verifies every profile; `--update` rewrites
// the profileDigest fields (and the protected fixture digests of the
// validator profile) after a reviewed edit. Updating is a review step, not
// something the Job ever does.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const update = process.argv.includes("--update");
	if (update) {
		const files = readdirSync(profilesDir).filter((n) => n.endsWith(".json"));
		const docs = new Map<string, Record<string, unknown>>();
		for (const f of files) docs.set(f, parseStrictObject(readFileSync(path.join(profilesDir, f), "utf8"), f));
		for (const [f, doc] of docs) {
			if (f.startsWith("validator-") && doc.protectedFixtures && typeof doc.protectedFixtures === "object") {
				const fixtures: Record<string, string> = {};
				for (const rel of Object.keys(doc.protectedFixtures as Record<string, string>).sort()) {
					fixtures[rel] = sha256(readFileSync(path.join(packageRoot, rel)));
				}
				doc.protectedFixtures = fixtures;
			}
			doc.profileDigest = profileDigest(doc);
			writeFileSync(path.join(profilesDir, f), `${JSON.stringify(doc, null, 2)}\n`);
			console.log(`${f}: ${doc.profileDigest}`);
		}
	}
	const p = loadProfiles();
	const fixtures = protectedFixturesIntact(p);
	if (!fixtures.intact) {
		console.error(`protected fixtures altered: ${fixtures.altered.join(", ")}`);
		process.exit(1);
	}
	const tools = verifyToolchain(p);
	console.log(
		JSON.stringify({
			ok: true,
			validator: p.validator.profileDigest,
			build: p.build.profileDigest,
			host: p.host.profileDigest,
			toolchain: tools,
		}),
	);
}
