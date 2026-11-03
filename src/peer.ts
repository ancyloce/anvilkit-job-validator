// The second peer binding of the access sidecar's sockets (DD-03 §5,
// DEC-045 B2): the launcher issues one secret per launch to the sidecar and
// to this trusted process (never to the candidate); each side derives the
// socket's token from it, every request carries the token and a fresh
// nonce, and every answer carries the sidecar's proof over that nonce, so
// a process that merely holds the abstract socket name (which anything in
// the Pod can bind) cannot pass for the sidecar. The first binding, the
// peer UID the sidecar reads at accept, stays the sidecar's.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HEADER_PEER_TOKEN = "anvilkit-peer-token";
export const HEADER_PEER_NONCE = "anvilkit-peer-nonce";
export const HEADER_SIDECAR_PROOF = "anvilkit-sidecar-proof";

const secretPattern = /^[0-9a-f]{64}$/;
const noncePattern = /^[0-9a-f]{32}$/;

/** True for exactly 64 lowercase hex characters (32 bytes). */
export function isLaunchSecret(value: string): boolean {
	return secretPattern.test(value);
}

/** token(role) = hex(HMAC-SHA256(secret bytes, "anvilkit/peer-token/v1/" + role)). */
export function peerToken(secretHex: string, role: "trusted" | "candidate"): string {
	if (!isLaunchSecret(secretHex)) throw new Error("launch secret: expected 64 lowercase hex characters");
	return createHmac("sha256", Buffer.from(secretHex, "hex")).update(`anvilkit/peer-token/v1/${role}`).digest("hex");
}

/** 16 fresh random bytes as 32 lowercase hex characters. */
export function newNonce(): string {
	return randomBytes(16).toString("hex");
}

/** proof = hex(HMAC-SHA256(token bytes, "anvilkit/sidecar-proof/v1/" + nonce)). */
export function sidecarProof(tokenHex: string, nonce: string): string {
	if (!noncePattern.test(nonce)) throw new Error("peer nonce: expected 32 lowercase hex characters");
	return createHmac("sha256", Buffer.from(tokenHex, "hex")).update(`anvilkit/sidecar-proof/v1/${nonce}`).digest("hex");
}

/** Constant-time check of an answer's proof header against the token and the nonce of the request. */
export function proofMatches(tokenHex: string, nonce: string, header: string | string[] | undefined): boolean {
	if (typeof header !== "string" || header.length !== 64) return false;
	const expected = Buffer.from(sidecarProof(tokenHex, nonce), "hex");
	const got = Buffer.from(header, "hex");
	return got.length === expected.length && timingSafeEqual(got, expected);
}

/** An abstract-namespace socket name (`@name`) as Node's socketPath (`\0name`); a filesystem path is returned as is. */
export function socketPathOf(name: string): string {
	return name.startsWith("@") ? `\0${name.slice(1)}` : name;
}
