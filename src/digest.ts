// Digests and canonical encodings shared by the trusted validator. Every
// binding of the certification (source, profiles, artifacts, evidence) is
// a sha256 over exact bytes, written as the contract's "sha256:<hex>".
import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

export const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function sha256(bytes: Uint8Array | string): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Digest of several byte sequences, each length-prefixed so boundaries bind. */
export function sha256Parts(parts: Array<Uint8Array | string>): Digest {
	const h = createHash("sha256");
	for (const p of parts) {
		const b = typeof p === "string" ? Buffer.from(p, "utf8") : p;
		h.update(`${b.byteLength}\0`);
		h.update(b);
	}
	return `sha256:${h.digest("hex")}`;
}

/**
 * Canonical JSON: object keys sorted, no whitespace, no undefined members.
 * Two documents with the same content produce the same bytes and digest.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			const v = (value as Record<string, unknown>)[k];
			if (v !== undefined) out[k] = sortKeys(v);
		}
		return out;
	}
	return value;
}

export function canonicalDigest(value: unknown): Digest {
	return sha256(canonicalJson(value));
}

/** Decimal string of a byte count as the contracts write 64-bit counters. */
export function sequence(n: number | bigint): string {
	return BigInt(n).toString(10);
}
