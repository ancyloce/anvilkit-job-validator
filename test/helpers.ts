import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const heroSource = path.join(packageRoot, "fixtures", "component", "hero");

/** A disposable copy of a fixture directory (world-readable, as a staged workspace is). */
export function scratchCopy(source: string, prefix = "anvilkit-validator-"): { dir: string; dispose: () => void } {
	const base = process.env.ANVILKIT_VALIDATOR_SCRATCH ?? tmpdir();
	const dir = mkdtempSync(path.join(base, prefix));
	cpSync(source, dir, { recursive: true });
	return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
