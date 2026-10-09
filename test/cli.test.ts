import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { heroSource, packageRoot } from "./helpers.js";

const scratch: string[] = [];
function out(): string {
	const d = mkdtempSync(path.join(tmpdir(), "anvilkit-cli-"));
	scratch.push(d);
	return d;
}
afterAll(() => {
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function certify(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const run = spawnSync(process.execPath, ["--import", "tsx", path.join(packageRoot, "src", "cli.ts"), ...args], {
		cwd: packageRoot,
		env: { ...process.env },
		encoding: "utf8",
		timeout: 170_000,
	});
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const hero = ["--component-id", "cmp_hero_fixed", "--puck-type", "Hero", "--package-name", "@anvilkit/hero-fixed"];

describe("the local certify entry (cli.ts)", () => {
	it("requires the source revision and the whole identity, or none of it", () => {
		const noRevision = certify([heroSource, "--out", out()]);
		expect(noRevision.status).toBe(2);
		expect(noRevision.stderr).toMatch(/usage: certify <sourceDir> --source-revision <n>/);
		const partial = certify([heroSource, "--source-revision", "7", "--out", out(), "--puck-type", "Hero"]);
		expect(partial.status).toBe(2);
		expect(partial.stderr).toMatch(/go together/);
	});

	it("refuses a source whose puckType or package name is not the given identity (IDENTITY_MISMATCH)", () => {
		for (const [flag, value, field] of [
			["--puck-type", "Banner", "puckType"],
			["--package-name", "@acme/hero", "package.json name"],
		] as const) {
			const args = [...hero];
			args[args.indexOf(flag) + 1] = value;
			const run = certify([heroSource, "--source-revision", "7", "--out", out(), ...args]);
			expect(run.status, run.stderr).toBe(1);
			const refusal = JSON.parse(run.stderr.trim().split("\n").at(-1) ?? "{}") as { code: string; message: string };
			expect(refusal.code).toBe("IDENTITY_MISMATCH");
			expect(refusal.message).toContain(field);
		}
	});

	it("binds the given source revision and identity in the certification", () => {
		// A diagnostic run (no host checks) is enough to read the bindings.
		const dir = out();
		const run = certify([heroSource, "--source-revision", "7", "--out", dir, ...hero, "--no-ssr", "--no-browser"]);
		expect(run.status, run.stderr).toBe(0);
		const cert = JSON.parse(readFileSync(path.join(dir, "certification.json"), "utf8")) as {
			bindings: Record<string, unknown>;
			checks: Array<{ name: string; status: string }>;
		};
		expect(cert.bindings).toMatchObject({
			componentId: "cmp_hero_fixed",
			puckType: "Hero",
			packageName: "@anvilkit/hero-fixed",
			sourceRevision: "7",
		});
		expect(cert.checks.find((c) => c.name === "source-contract")?.status).toBe("pass");
	});
});
