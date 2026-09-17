// npm tarball reading for the trusted side: the inventory of a gzipped tar
// as bytes describe it (entry paths, sizes, digests), without extraction and
// with the containment rules of the artifact boundary (regular files under
// package/ only, no links, no absolute or upward paths, bounded count and
// bytes). Both the build (to record what it produced) and the observer (to
// inspect what was produced, independently) read through this.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as tar from "tar";
import { type Digest, sequence } from "./digest.js";

export interface TarEntry {
	/** Path inside the package (without the package/ prefix). */
	path: string;
	digest: Digest;
	sizeBytes: string;
	mode: number;
}

export interface TarLimits {
	maxEntries: number;
	maxUncompressedBytes: number;
}

export class TarballError extends Error {}

const entryPath = /^package\/([A-Za-z0-9_@.-]+(\/[A-Za-z0-9_@.-]+)*)$/;

export async function readTarball(file: string, limits: TarLimits): Promise<TarEntry[]> {
	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	let total = 0;
	let failure: Error | undefined;
	const fail = (msg: string) => {
		if (!failure) failure = new TarballError(msg);
	};
	await new Promise<void>((resolve, reject) => {
		const parser = new tar.Parser({
			strict: true,
			onReadEntry(entry) {
				if (failure) {
					entry.resume();
					return;
				}
				const m = entryPath.exec(entry.path);
				if (entry.type !== "File") {
					fail(`${entry.path}: ${entry.type} entries are not accepted`);
					entry.resume();
					return;
				}
				if (!m || entry.path.split("/").some((s) => s === "." || s === "..")) {
					fail(`${entry.path}: not a normalized path under package/`);
					entry.resume();
					return;
				}
				const rel = m[1] as string;
				if (seen.has(rel)) {
					fail(`${entry.path}: named twice`);
					entry.resume();
					return;
				}
				seen.add(rel);
				if (entries.length >= limits.maxEntries) {
					fail(`more than ${limits.maxEntries} entries`);
					entry.resume();
					return;
				}
				const size = entry.size;
				total += size;
				if (total > limits.maxUncompressedBytes) {
					fail(`uncompressed bytes exceed ${limits.maxUncompressedBytes}`);
					entry.resume();
					return;
				}
				const h = createHash("sha256");
				let seenBytes = 0;
				entry.on("data", (c: Buffer) => {
					seenBytes += c.length;
					h.update(c);
				});
				entry.on("end", () => {
					if (seenBytes !== size) fail(`${entry.path}: header size ${size}, ${seenBytes} bytes`);
					entries.push({
						path: rel,
						digest: `sha256:${h.digest("hex")}`,
						sizeBytes: sequence(size),
						mode: entry.mode ?? 0,
					});
				});
			},
		});
		parser.on("error", reject);
		parser.on("end", resolve);
		createReadStream(file).on("error", reject).pipe(parser);
	});
	if (failure) throw failure;
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return entries;
}

/** Fixed mtime of every entry: npm's own choice for reproducible packs. */
export const packMtime = new Date("1985-10-26T08:15:00.000Z");

/** Writes a gzipped npm-layout tarball (entries under package/, no directories, fixed mtime, no owner). */
export async function writeTarball(stageDir: string, relativeFiles: string[], file: string): Promise<void> {
	await tar.create(
		{ gzip: { level: 9 }, portable: true, mtime: packMtime, cwd: stageDir, noDirRecurse: true, file, follow: false },
		[...relativeFiles].sort().map((p) => `package/${p}`),
	);
}
