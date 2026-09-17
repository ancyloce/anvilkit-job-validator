// The complete-source contract (DD-04 §1, contracts/components
// component.schema.json#/$defs/sourceManifest). The trusted reader walks the
// candidate's directory itself, refuses what the contract forbids, and
// computes the manifest and its digest from the actual bytes. The
// candidate's own declaration (component.json) names its entry, styles,
// resources, usage and editable fields; every declared item is checked
// against the inventory and nothing declared is trusted without it.
//
// Reviewed layout of a complete source:
//   component.json          the declaration (schemaVersion 1)
//   package.json            name, version, exact dependencies only
//   pnpm-lock.yaml          the candidate's lockfile (recorded by digest,
//                           never installed from)
//   <usage>.md              usage instructions named by the declaration
//   src/**/*.ts|*.tsx       code; the entry is src/index.tsx
//   styles/**/*.css         every stylesheet, each declared
//   assets/**               every resource, each declared
// Anything else — build configuration, lockfile overrides, node_modules,
// links, special files, aliases, escapes — is a refusal, never ignored.
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import validatePackageName from "validate-npm-package-name";
import { parse as parseYaml } from "yaml";
import { componentsSchemaId, parseStrictObject, validateAgainst } from "./contracts.js";
import { type Digest, sequence, sha256, sha256Parts } from "./digest.js";
import type { BuildSupportProfile, ValidatorProfile } from "./profiles.js";

export const fieldTypes = [
	"text",
	"textarea",
	"number",
	"select",
	"radio",
	"array",
	"object",
	"external",
	"custom",
] as const;
export type FieldType = (typeof fieldTypes)[number];

export interface EditableField {
	name: string;
	type: FieldType;
	default?: unknown;
}

export interface ComponentDeclaration {
	schemaVersion: 1;
	componentId: string;
	puckType: string;
	entry: string;
	styles: string[];
	resources: string[];
	usage: string;
	editableFields: EditableField[];
}

export interface FileEntry {
	path: string;
	digest: Digest;
	sizeBytes: string;
}

export interface SourceManifest {
	schemaVersion: 1;
	componentId: string;
	sourceRevision: string;
	entry: string;
	files: FileEntry[];
	styles: string[];
	dependencies: Record<string, string>;
	lockfileDigest: Digest;
	editableFields: EditableField[];
	manifestDigest: Digest;
}

export interface SourceRead {
	/** Real path of the source root. */
	root: string;
	manifest: SourceManifest;
	declaration: ComponentDeclaration;
	packageName: string;
	packageVersion: string;
	/** Bytes of every inventoried file, by normalized relative path. */
	files: Map<string, Buffer>;
}

/** A source defect: PATH_ESCAPE for the path rules, CANDIDATE_BUILD_FAILED for everything the profile cannot build. */
export class SourceError extends Error {
	constructor(
		readonly code: "PATH_ESCAPE" | "CANDIDATE_BUILD_FAILED",
		message: string,
	) {
		super(message);
	}
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const puckTypePattern = /^[A-Z][A-Za-z0-9]{0,63}$/;
const fieldNamePattern = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
const segmentPattern = /^\.?[A-Za-z0-9_@-][A-Za-z0-9._@-]*$/;
const maxDepth = 16;
const maxPathLength = 512;

// Candidate build configuration never reaches the trusted build (DD-04 §2);
// its presence in a complete source is a defect, not something to skip.
const configurationNames = [
	/^rollup\.config\./,
	/^vite\.config\./,
	/^vitest\.config\./,
	/^webpack\.config\./,
	/^rspack\.config\./,
	/^rslib\.config\./,
	/^esbuild\.config\./,
	/^postcss\.config\./,
	/^tailwind\.config\./,
	/^babel\.config\./,
	/^\.babelrc/,
	/^\.swcrc$/,
	/^tsconfig.*\.json$/,
	/^\.npmrc$/,
	/^\.pnpmfile\.(cjs|js|mjs)$/,
	/^pnpm-workspace\.yaml$/,
	/^\.yarnrc/,
	/^\.env/,
	/^package-lock\.json$/,
	/^yarn\.lock$/,
	/^bun\.lockb?$/,
];
const refusedDirectories = new Set(["node_modules", ".git", "dist", "build", "out", ".pnpm-store"]);
const resourceExtensions = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff2", ".json", ".txt"]);
const rootFiles = new Set(["component.json", "package.json", "pnpm-lock.yaml", "LICENSE"]);
const allowedPackageKeys = new Set(["name", "version", "description", "license", "dependencies"]);

/**
 * A package name the registry accepts for a new package (validate-npm-package-name:
 * no legacy names, no special characters, no blacklisted names) — the first
 * error or warning text otherwise. Nothing is repaired or lowercased here.
 */
function packageNameProblem(name: unknown): string | undefined {
	if (typeof name !== "string") return "is not a string";
	const r = validatePackageName(name);
	if (r.validForNewPackages) return undefined;
	return [...(r.errors ?? []), ...(r.warnings ?? [])][0] ?? "is not a package name";
}

/**
 * An exact version: node-semver parses it strictly (no leading zeros in
 * numeric identifiers, no empty prerelease identifiers) and its canonical
 * form is the input itself (no "v" prefix, whitespace, build metadata or
 * range syntax). coerce/clean are never used: input is refused, not repaired.
 */
function isExactVersion(version: unknown): version is string {
	return typeof version === "string" && semver.valid(version, { loose: false }) === version;
}

interface Walked {
	files: Map<string, Buffer>;
	totalBytes: number;
}

function walk(root: string, limits: ValidatorProfile["limits"]): Walked {
	const files = new Map<string, Buffer>();
	const folded = new Map<string, string>();
	let total = 0;
	const visit = (dir: string, rel: string[]): void => {
		if (rel.length > maxDepth)
			throw new SourceError("PATH_ESCAPE", `${rel.join("/")}: deeper than ${maxDepth} segments`);
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			throw new SourceError("CANDIDATE_BUILD_FAILED", `${rel.join("/") || "."}: ${(err as Error).message}`);
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const name = entry.name;
			const relPath = [...rel, name].join("/");
			if (name.includes("/") || name.includes("\\") || name.includes("\0") || !segmentPattern.test(name)) {
				throw new SourceError("PATH_ESCAPE", `${relPath}: segment is not a normalized relative path segment`);
			}
			if (relPath.length > maxPathLength)
				throw new SourceError("PATH_ESCAPE", `${relPath}: longer than ${maxPathLength}`);
			const key = relPath.normalize("NFKC").toLowerCase();
			const other = folded.get(key);
			if (other !== undefined && other !== relPath) {
				throw new SourceError("PATH_ESCAPE", `${relPath} and ${other} are case aliases of one path`);
			}
			folded.set(key, relPath);
			const abs = path.join(dir, name);
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) throw new SourceError("PATH_ESCAPE", `${relPath}: symbolic links are refused`);
			if (st.isDirectory()) {
				if (refusedDirectories.has(name)) {
					throw new SourceError("CANDIDATE_BUILD_FAILED", `${relPath}/: not part of a complete source`);
				}
				visit(abs, [...rel, name]);
				continue;
			}
			if (!st.isFile()) throw new SourceError("PATH_ESCAPE", `${relPath}: not a regular file`);
			if (st.nlink > 1) throw new SourceError("PATH_ESCAPE", `${relPath}: hard-linked file`);
			if (configurationNames.some((re) => re.test(name))) {
				throw new SourceError(
					"CANDIDATE_BUILD_FAILED",
					`${relPath}: candidate build configuration is not accepted; the profile supplies the build`,
				);
			}
			if (st.size > limits.maxSourceFileBytes) {
				throw new SourceError(
					"CANDIDATE_BUILD_FAILED",
					`${relPath}: ${st.size} bytes exceeds the file bound ${limits.maxSourceFileBytes}`,
				);
			}
			total += st.size;
			if (total > limits.maxSourceBytes) {
				throw new SourceError("CANDIDATE_BUILD_FAILED", `source exceeds the byte bound ${limits.maxSourceBytes}`);
			}
			if (files.size >= limits.maxSourceFiles) {
				throw new SourceError("CANDIDATE_BUILD_FAILED", `source exceeds the file bound ${limits.maxSourceFiles}`);
			}
			const bytes = readFileSync(abs);
			if (bytes.byteLength !== st.size)
				throw new SourceError("CANDIDATE_BUILD_FAILED", `${relPath}: changed while being read`);
			files.set(relPath, bytes);
		}
	};
	visit(root, []);
	return { files, totalBytes: total };
}

function readDeclaration(files: Map<string, Buffer>): ComponentDeclaration {
	const raw = files.get("component.json");
	if (!raw) throw new SourceError("CANDIDATE_BUILD_FAILED", "component.json is missing");
	const doc = parseStrictObject(raw.toString("utf8"), "component.json");
	const keys = new Set(Object.keys(doc));
	const required = [
		"schemaVersion",
		"componentId",
		"puckType",
		"entry",
		"styles",
		"resources",
		"usage",
		"editableFields",
	];
	for (const k of required)
		if (!keys.has(k)) throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: ${k} is required`);
	for (const k of keys)
		if (!required.includes(k)) throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: unknown field ${k}`);
	if (doc.schemaVersion !== 1)
		throw new SourceError("CANDIDATE_BUILD_FAILED", "component.json: schemaVersion must be 1");
	const str = (k: string, re: RegExp): string => {
		const v = doc[k];
		if (typeof v !== "string" || !re.test(v) || v.length > 128)
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: ${k} is invalid`);
		return v;
	};
	const list = (k: string): string[] => {
		const v = doc[k];
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: ${k} must list paths`);
		const out = v as string[];
		if (new Set(out).size !== out.length)
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: ${k} names a path twice`);
		return out;
	};
	const fields = doc.editableFields;
	if (!Array.isArray(fields) || fields.length > 256)
		throw new SourceError("CANDIDATE_BUILD_FAILED", "component.json: editableFields must be a bounded list");
	const names = new Set<string>();
	const editableFields: EditableField[] = fields.map((f, i) => {
		if (!f || typeof f !== "object" || Array.isArray(f))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: editableFields[${i}] is not an object`);
		const field = f as Record<string, unknown>;
		for (const k of Object.keys(field)) {
			if (!["name", "type", "default"].includes(k))
				throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: editableFields[${i}]: unknown ${k}`);
		}
		if (typeof field.name !== "string" || !fieldNamePattern.test(field.name))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: editableFields[${i}].name is invalid`);
		if (typeof field.type !== "string" || !(fieldTypes as readonly string[]).includes(field.type))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: editableFields[${i}].type is invalid`);
		if (names.has(field.name))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `component.json: editable field ${field.name} declared twice`);
		names.add(field.name);
		const out: EditableField = { name: field.name, type: field.type as FieldType };
		if ("default" in field) out.default = field.default;
		return out;
	});
	return {
		schemaVersion: 1,
		componentId: str("componentId", idPattern),
		puckType: str("puckType", puckTypePattern),
		entry: str("entry", /^src\/index\.tsx$/),
		styles: list("styles"),
		resources: list("resources"),
		usage: str("usage", /^[A-Za-z0-9_-]+\.md$/),
		editableFields,
	};
}

function readPackage(
	files: Map<string, Buffer>,
	profile: BuildSupportProfile,
): { name: string; version: string; dependencies: Record<string, string> } {
	const raw = files.get("package.json");
	if (!raw) throw new SourceError("CANDIDATE_BUILD_FAILED", "package.json is missing");
	const doc = parseStrictObject(raw.toString("utf8"), "package.json");
	for (const k of Object.keys(doc)) {
		if (!allowedPackageKeys.has(k)) {
			throw new SourceError(
				"CANDIDATE_BUILD_FAILED",
				`package.json: field ${k} is not accepted (no scripts, exports, files, workspaces or overrides; the profile publishes the package)`,
			);
		}
	}
	const name = doc.name;
	const version = doc.version;
	const nameProblem = packageNameProblem(name);
	if (typeof name !== "string" || nameProblem !== undefined)
		throw new SourceError("CANDIDATE_BUILD_FAILED", `package.json: name ${nameProblem ?? "is not a string"}`);
	if (!isExactVersion(version))
		throw new SourceError("CANDIDATE_BUILD_FAILED", "package.json: version is not an exact semver");
	const deps = doc.dependencies ?? {};
	if (!deps || typeof deps !== "object" || Array.isArray(deps))
		throw new SourceError("CANDIDATE_BUILD_FAILED", "package.json: dependencies must be an object");
	const dependencies: Record<string, string> = {};
	for (const [dep, want] of Object.entries(deps as Record<string, unknown>)) {
		const depProblem = packageNameProblem(dep);
		if (depProblem !== undefined)
			throw new SourceError("CANDIDATE_BUILD_FAILED", `package.json: dependency name ${dep} ${depProblem}`);
		if (!isExactVersion(want))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `package.json: dependency ${dep} must pin an exact version`);
		const allowed = profile.allowedDependencies[dep];
		if (allowed === undefined)
			throw new SourceError(
				"CANDIDATE_BUILD_FAILED",
				`package.json: dependency ${dep} is not supported by profile ${profile.profileId}`,
			);
		if (allowed !== want)
			throw new SourceError(
				"CANDIDATE_BUILD_FAILED",
				`package.json: dependency ${dep}@${want} is not the supported ${allowed}`,
			);
		dependencies[dep] = want;
	}
	if (!dependencies.react) throw new SourceError("CANDIDATE_BUILD_FAILED", "package.json: react must be declared");
	return { name, version, dependencies };
}

function checkLockfile(files: Map<string, Buffer>, dependencies: Record<string, string>): Digest {
	const raw = files.get("pnpm-lock.yaml");
	if (!raw) throw new SourceError("CANDIDATE_BUILD_FAILED", "pnpm-lock.yaml is missing");
	let doc: unknown;
	try {
		doc = parseYaml(raw.toString("utf8"), { uniqueKeys: true });
	} catch (err) {
		throw new SourceError("CANDIDATE_BUILD_FAILED", `pnpm-lock.yaml: ${(err as Error).message}`);
	}
	if (!doc || typeof doc !== "object")
		throw new SourceError("CANDIDATE_BUILD_FAILED", "pnpm-lock.yaml: not a lockfile");
	const lock = doc as Record<string, unknown>;
	if (typeof lock.lockfileVersion !== "string" || !/^9\./.test(lock.lockfileVersion)) {
		throw new SourceError("CANDIDATE_BUILD_FAILED", "pnpm-lock.yaml: lockfileVersion 9.x is required");
	}
	const importers = lock.importers as Record<string, Record<string, unknown>> | undefined;
	const root = importers?.["."];
	if (!importers || !root || Object.keys(importers).length !== 1) {
		throw new SourceError(
			"CANDIDATE_BUILD_FAILED",
			"pnpm-lock.yaml: exactly one importer (the package root) is expected",
		);
	}
	for (const section of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
		if (section in root)
			throw new SourceError("CANDIDATE_BUILD_FAILED", `pnpm-lock.yaml: ${section} are not part of a complete source`);
	}
	const locked = (root.dependencies ?? {}) as Record<string, { specifier?: unknown; version?: unknown }>;
	const declared = Object.keys(dependencies).sort();
	const found = Object.keys(locked).sort();
	if (declared.join("\n") !== found.join("\n")) {
		throw new SourceError(
			"CANDIDATE_BUILD_FAILED",
			`pnpm-lock.yaml: locked dependencies [${found.join(", ")}] differ from the declared [${declared.join(", ")}]`,
		);
	}
	for (const dep of declared) {
		const entry = locked[dep];
		const want = dependencies[dep] as string;
		const version = typeof entry?.version === "string" ? entry.version : "";
		if (entry?.specifier !== want || !(version === want || version.startsWith(`${want}(`))) {
			throw new SourceError(
				"CANDIDATE_BUILD_FAILED",
				`pnpm-lock.yaml: ${dep} is locked as ${String(entry?.specifier)} / ${version}, the source declares ${want}`,
			);
		}
	}
	return sha256(raw);
}

/** The manifest digest: the sorted normalized paths and the actual bytes, boundary-bound. */
export function manifestDigest(files: Map<string, Buffer>): Digest {
	const parts: Array<Uint8Array | string> = [];
	for (const p of [...files.keys()].sort()) {
		parts.push(p);
		parts.push(files.get(p) as Buffer);
	}
	return sha256Parts(parts);
}

/**
 * Reads a complete source and computes its manifest. sourceRevision is
 * the content authority's revision of these bytes (the caller's, never the
 * candidate's); the digest is computed here from the bytes alone.
 */
export function readSource(
	dir: string,
	opts: { sourceRevision: string; profile: BuildSupportProfile; limits: ValidatorProfile["limits"] },
): SourceRead {
	if (!/^(0|[1-9][0-9]{0,19})$/.test(opts.sourceRevision))
		throw new SourceError("CANDIDATE_BUILD_FAILED", `source revision ${opts.sourceRevision} is not a sequence`);
	let root: string;
	try {
		root = realpathSync(dir);
	} catch (err) {
		throw new SourceError("CANDIDATE_BUILD_FAILED", `source root: ${(err as Error).message}`);
	}
	if (!lstatSync(root).isDirectory()) throw new SourceError("CANDIDATE_BUILD_FAILED", `${dir} is not a directory`);
	const { files } = walk(root, opts.limits);
	if (files.size === 0) throw new SourceError("CANDIDATE_BUILD_FAILED", "the source is empty");
	const declaration = readDeclaration(files);
	const pkg = readPackage(files, opts.profile);
	const lockfileDigest = checkLockfile(files, pkg.dependencies);

	// Layout: every file has one reviewed place, and every declared item
	// exists in the inventory.
	const declaredStyles = new Set(declaration.styles);
	const declaredResources = new Set(declaration.resources);
	for (const p of files.keys()) {
		const [head, ...rest] = p.split("/");
		if (rest.length === 0) {
			if (!rootFiles.has(p) && p !== declaration.usage)
				throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: not part of the reviewed layout`);
			continue;
		}
		const ext = path.posix.extname(p);
		switch (head) {
			case "src":
				if (ext !== ".ts" && ext !== ".tsx")
					throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: only .ts/.tsx code lives under src/`);
				if (/\.d\.ts$/.test(p))
					throw new SourceError(
						"CANDIDATE_BUILD_FAILED",
						`${p}: declaration files are produced by the build, not accepted from the source`,
					);
				break;
			case "styles":
				if (ext !== ".css") throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: only .css lives under styles/`);
				if (!declaredStyles.has(p))
					throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: stylesheet is not declared in component.json styles`);
				break;
			case "assets":
				if (!resourceExtensions.has(ext))
					throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: resource type ${ext || "(none)"} is not supported`);
				if (!declaredResources.has(p))
					throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: resource is not declared in component.json resources`);
				break;
			default:
				throw new SourceError("CANDIDATE_BUILD_FAILED", `${p}: not part of the reviewed layout`);
		}
	}
	if (!files.has(declaration.entry))
		throw new SourceError("CANDIDATE_BUILD_FAILED", `entry ${declaration.entry} is missing`);
	if (!files.has(declaration.usage))
		throw new SourceError("CANDIDATE_BUILD_FAILED", `usage ${declaration.usage} is missing`);
	for (const s of declaration.styles) {
		if (!s.startsWith("styles/") || !s.endsWith(".css"))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `declared style ${s} is outside styles/`);
		if (!files.has(s)) throw new SourceError("CANDIDATE_BUILD_FAILED", `declared style ${s} is missing`);
		if ((files.get(s) as Buffer).byteLength === 0)
			throw new SourceError("CANDIDATE_BUILD_FAILED", `declared style ${s} is empty`);
	}
	for (const r of declaration.resources) {
		if (!r.startsWith("assets/"))
			throw new SourceError("CANDIDATE_BUILD_FAILED", `declared resource ${r} is outside assets/`);
		if (!files.has(r)) throw new SourceError("CANDIDATE_BUILD_FAILED", `declared resource ${r} is missing`);
	}

	const entries: FileEntry[] = [...files.keys()].sort().map((p) => {
		const bytes = files.get(p) as Buffer;
		return { path: p, digest: sha256(bytes), sizeBytes: sequence(bytes.byteLength) };
	});
	const manifest: SourceManifest = {
		schemaVersion: 1,
		componentId: declaration.componentId,
		sourceRevision: opts.sourceRevision,
		entry: declaration.entry,
		files: entries,
		styles: [...declaration.styles],
		dependencies: pkg.dependencies,
		lockfileDigest,
		editableFields: declaration.editableFields,
		manifestDigest: manifestDigest(files),
	};
	const shape = validateAgainst(`${componentsSchemaId}#/$defs/sourceManifest`, manifest);
	if (shape) throw new SourceError("CANDIDATE_BUILD_FAILED", `source manifest does not satisfy the contract: ${shape}`);
	return { root, manifest, declaration, packageName: pkg.name, packageVersion: pkg.version, files };
}
