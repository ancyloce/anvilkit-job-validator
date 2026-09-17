// The contract schemas the validator consumes (contracts/components,
// contracts/jobs of anvilkit-agent-contracts): read from a directory named
// by the environment or found beside this package in the parent checkout,
// compiled once. The validator never trusts a candidate's declared shape;
// what it produces (the source manifest, the result manifest) is checked
// against the same schemas Control validates with.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const componentsSchemaId = "urn:anvilkit:components:v1";
export const jobsSchemaId = "urn:anvilkit:jobs:v1";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The directory holding components/component.schema.json and jobs/job.schema.json. */
export function contractsDir(): string {
	const env = process.env.ANVILKIT_VALIDATOR_CONTRACTS_DIR;
	if (env) return env;
	for (const candidate of [path.join(packageRoot, "contracts"), path.resolve(packageRoot, "..", "..", "contracts")]) {
		if (existsSync(path.join(candidate, "components", "component.schema.json"))) return candidate;
	}
	throw new Error(
		"contracts not found: set ANVILKIT_VALIDATOR_CONTRACTS_DIR to a directory holding components/component.schema.json and jobs/job.schema.json",
	);
}

let compiled: Ajv2020 | undefined;

function ajv(): Ajv2020 {
	if (compiled) return compiled;
	const dir = contractsDir();
	// strictRequired is off: the jobs contract states "no failureCode under a
	// certified verdict" as then/not/required inside allOf, which Ajv's strict
	// mode cannot pair with a properties declaration; every other strict
	// check stays on.
	const a = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, allowUnionTypes: true });
	addFormats.default ? addFormats.default(a) : (addFormats as unknown as (a: Ajv2020) => void)(a);
	for (const rel of ["components/component.schema.json", "jobs/job.schema.json"]) {
		const schema = JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
		a.addSchema(schema);
	}
	compiled = a;
	return a;
}

export type ContractRef = `${typeof componentsSchemaId}#/$defs/${string}` | `${typeof jobsSchemaId}#/$defs/${string}`;

/** Validates an instance against one $defs entry; returns the first error text or undefined. */
export function validateAgainst(ref: ContractRef, instance: unknown): string | undefined {
	const a = ajv();
	let v = a.getSchema(ref);
	if (!v) {
		a.addSchema({ $id: `urn:anvilkit:validator:ref:${ref}`, $ref: ref }, ref);
		v = a.getSchema(ref);
	}
	if (!v) throw new Error(`contract ref ${ref} does not compile`);
	if (v(instance)) return undefined;
	const e = v.errors?.[0];
	return e ? `${e.instancePath || "/"} ${e.message ?? "invalid"}` : "invalid";
}

/** Strict JSON parsing: one document, an object, no duplicate keys, no trailing data. */
export function parseStrictObject(text: string, what: string): Record<string, unknown> {
	assertNoDuplicateKeys(text, what);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		throw new Error(`${what}: ${(err as Error).message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what}: not a JSON object`);
	return value as Record<string, unknown>;
}

// JSON.parse keeps the last duplicate silently; the contracts require strict
// parsing (contracts.md §4), so duplicates are found by a small tokenizer
// that tracks the key set of every object on the stack.
function assertNoDuplicateKeys(text: string, what: string): void {
	const stack: Array<Set<string> | null> = [];
	let i = 0;
	let expectKey = false;
	while (i < text.length) {
		const c = text[i] as string;
		if (c === '"') {
			let j = i + 1;
			let s = "";
			while (j < text.length && text[j] !== '"') {
				if (text[j] === "\\") {
					s += text[j] as string;
					j++;
				}
				s += text[j] as string;
				j++;
			}
			const top = stack[stack.length - 1];
			if (expectKey && top) {
				let key: string;
				try {
					key = JSON.parse(`"${s}"`);
				} catch {
					key = s;
				}
				if (top.has(key)) throw new Error(`${what}: duplicate key ${JSON.stringify(key)}`);
				top.add(key);
				expectKey = false;
			}
			i = j + 1;
			continue;
		}
		if (c === "{") {
			stack.push(new Set());
			expectKey = true;
		} else if (c === "[") {
			stack.push(null);
			expectKey = false;
		} else if (c === "}" || c === "]") {
			stack.pop();
			expectKey = false;
		} else if (c === ",") {
			expectKey = stack[stack.length - 1] !== null && stack.length > 0;
		}
		i++;
	}
}
