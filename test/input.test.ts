import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { InputError, unpackSourceArchive } from "../src/input.js";

const limits = { maxSourceFiles: 8, maxSourceFileBytes: 1024, maxSourceBytes: 4096 };

async function archiveOf(cwd: string, entries: string[]): Promise<Buffer> {
	const file = path.join(cwd, "..", "archive.tar");
	await tar.create({ portable: true, cwd, file, follow: false, noDirRecurse: true }, entries);
	return readFileSync(file);
}

describe("the source input of a launch (P13-04)", () => {
	const dirs: string[] = [];
	const scratch = () => {
		const d = mkdtempSync(path.join(tmpdir(), "anvilkit-input-"));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("unpacks regular files under normalized relative paths", async () => {
		const src = path.join(scratch(), "src");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(path.join(src, "lib"), { recursive: true });
		writeFileSync(path.join(src, "package.json"), '{"name":"@acme/hero"}');
		writeFileSync(path.join(src, "lib", "Hero.tsx"), "export const Hero = () => null;");
		const archive = await archiveOf(src, ["package.json", "lib/Hero.tsx"]);
		const out = path.join(scratch(), "out");
		const files = await unpackSourceArchive(archive, out, limits);
		expect(files).toEqual(["lib/Hero.tsx", "package.json"]);
		expect(readFileSync(path.join(out, "lib", "Hero.tsx"), "utf8")).toContain("Hero");
	});

	it("refuses a path escape, a link and an oversized archive before anything is read as source", async () => {
		const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
		const src = path.join(scratch(), "src");
		mkdirSync(src, { recursive: true });
		writeFileSync(path.join(src, "a.ts"), "1");
		symlinkSync("/etc/passwd", path.join(src, "link"));
		const linked = await archiveOf(src, ["a.ts", "link"]);
		await expect(unpackSourceArchive(linked, path.join(scratch(), "o1"), limits)).rejects.toBeInstanceOf(InputError);
		// A hand-built entry that escapes the root.
		const escaping = await new Promise<Buffer>((resolve) => {
			const chunks: Buffer[] = [];
			const pack = new tar.Pack({ portable: true });
			pack.on("data", (c: Buffer) => chunks.push(c));
			pack.on("end", () => resolve(Buffer.concat(chunks)));
			const header = new tar.Header({ path: "../escape.ts", type: "File", size: 1, mode: 0o644, mtime: new Date(0) });
			header.encode();
			const entry = new tar.ReadEntry(header);
			pack.add(entry as never);
			entry.write(Buffer.from("x"));
			entry.end();
			pack.end();
		});
		await expect(unpackSourceArchive(escaping, path.join(scratch(), "o2"), limits)).rejects.toBeInstanceOf(InputError);
		writeFileSync(path.join(src, "big.ts"), "x".repeat(2048));
		const big = await archiveOf(src, ["a.ts", "big.ts"]);
		await expect(unpackSourceArchive(big, path.join(scratch(), "o3"), limits)).rejects.toBeInstanceOf(InputError);
	});
});
