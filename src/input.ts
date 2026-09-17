// The source input of a launch (P13-04): a codegen source archive the
// Workflow named in the launch envelope by handle, loaded by the access
// sidecar from Control's accepted stage and read back here, then unpacked
// under the same rules the source contract states for a tree — regular
// files only, normalized relative paths, bounded count and bytes — so a
// path escape, a link or an oversized archive is refused before anything
// is read as source. The unpacked tree is then read like the fixed source.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";

export class InputError extends Error {
	readonly code = "PATH_ESCAPE";
}

export interface UnpackLimits {
	maxSourceFiles: number;
	maxSourceFileBytes: number;
	maxSourceBytes: number;
}

const segment = /^[A-Za-z0-9_@.-]+$/;

/** Unpacks a source archive (a tar of regular files under relative normalized paths) into dir; refuses anything else. */
export async function unpackSourceArchive(archive: Buffer, dir: string, limits: UnpackLimits): Promise<string[]> {
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const root = path.resolve(dir);
	const files: string[] = [];
	const seen = new Set<string>();
	let total = 0;
	let failure: Error | undefined;
	const fail = (msg: string) => {
		if (!failure) failure = new InputError(msg);
	};
	await new Promise<void>((resolve, reject) => {
		const parser = new tar.Parser({
			strict: true,
			onReadEntry(entry) {
				if (failure) {
					entry.resume();
					return;
				}
				if (entry.type !== "File") {
					fail(`${entry.path}: ${entry.type} entries are not accepted`);
					entry.resume();
					return;
				}
				const parts = entry.path.split("/");
				if (entry.path.startsWith("/") || parts.some((s) => s === "" || s === "." || s === ".." || !segment.test(s))) {
					fail(`${entry.path}: not a normalized relative path`);
					entry.resume();
					return;
				}
				const rel = parts.join("/");
				const target = path.resolve(root, rel);
				if (!target.startsWith(`${root}${path.sep}`)) {
					fail(`${entry.path}: escapes the source root`);
					entry.resume();
					return;
				}
				if (seen.has(rel)) {
					fail(`${entry.path}: named twice`);
					entry.resume();
					return;
				}
				seen.add(rel);
				if (seen.size > limits.maxSourceFiles) {
					fail(`more than ${limits.maxSourceFiles} files`);
					entry.resume();
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				entry.on("data", (c: Buffer) => {
					size += c.length;
					total += c.length;
					if (size > limits.maxSourceFileBytes) fail(`${entry.path}: exceeds ${limits.maxSourceFileBytes} bytes`);
					else if (total > limits.maxSourceBytes) fail(`the archive exceeds ${limits.maxSourceBytes} bytes`);
					else chunks.push(c);
				});
				entry.on("end", () => {
					if (failure) return;
					mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
					writeFileSync(target, Buffer.concat(chunks), { mode: 0o644 });
					files.push(rel);
				});
			},
		});
		parser.on("error", reject);
		parser.on("end", resolve);
		Readable.from([archive]).pipe(parser);
	});
	if (failure) throw failure;
	if (files.length === 0) throw new InputError("the source archive holds no file");
	return files.sort();
}
