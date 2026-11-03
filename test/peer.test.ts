import { describe, expect, it } from "vitest";
import { isLaunchSecret, newNonce, peerToken, proofMatches, sidecarProof, socketPathOf } from "../src/peer.js";

// Fixed vectors of the DEC-045 B2 protocol (outputs/dec-045/RECORD.md §9):
// HMAC-SHA256 over the secret bytes, then over the token bytes.
const secret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const trusted = "346a23683ce20ea764a9bcd61d93bf8859a0551709f68ce6a3945e39c761b455";
const candidate = "ac57099efbec54f991ecfc70bad93eb0a20ad0977f0fad8259db48a9d6abdf35";
const nonce = "00112233445566778899aabbccddeeff";
const proof = "0e0f9f16b1ff5bb9d0e49c0a5f0248229ddf0323489cad9de2a1a637e109fd99";

describe("the peer binding helpers (DEC-045 B2)", () => {
	it("accepts exactly 64 lowercase hex characters as a launch secret", () => {
		expect(isLaunchSecret(secret)).toBe(true);
		expect(isLaunchSecret(secret.toUpperCase())).toBe(false);
		expect(isLaunchSecret(secret.slice(1))).toBe(false);
		expect(isLaunchSecret(`${secret}0`)).toBe(false);
		expect(isLaunchSecret("")).toBe(false);
		expect(() => peerToken("nope", "trusted")).toThrow(/64 lowercase hex/);
	});

	it("derives the socket tokens from the secret bytes", () => {
		expect(peerToken(secret, "trusted")).toBe(trusted);
		expect(peerToken(secret, "candidate")).toBe(candidate);
		expect(peerToken(secret, "trusted")).not.toBe(peerToken(secret, "candidate"));
	});

	it("derives and checks the sidecar's proof over the request's nonce", () => {
		expect(sidecarProof(trusted, nonce)).toBe(proof);
		expect(proofMatches(trusted, nonce, proof)).toBe(true);
		expect(proofMatches(candidate, nonce, proof)).toBe(false);
		expect(proofMatches(trusted, "ffffffffffffffffffffffffffffffff", proof)).toBe(false);
		expect(proofMatches(trusted, nonce, undefined)).toBe(false);
		expect(proofMatches(trusted, nonce, [proof])).toBe(false);
		expect(proofMatches(trusted, nonce, proof.slice(0, 63))).toBe(false);
		expect(proofMatches(trusted, nonce, `${proof.slice(0, 63)}0`)).toBe(false);
		expect(() => sidecarProof(trusted, "short")).toThrow(/32 lowercase hex/);
	});

	it("draws 16 fresh bytes per nonce", () => {
		const a = newNonce();
		const b = newNonce();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(b).toMatch(/^[0-9a-f]{32}$/);
		expect(a).not.toBe(b);
	});

	it("maps an abstract socket name to Node's NUL-prefixed socketPath", () => {
		expect(socketPathOf("@anvilkit/trusted")).toBe("\0anvilkit/trusted");
		expect(socketPathOf("/run/x/trusted.sock")).toBe("/run/x/trusted.sock");
	});
});
