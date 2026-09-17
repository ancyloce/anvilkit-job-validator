import { describe, expect, it } from "vitest";
import { componentsSchemaId, jobsSchemaId, parseStrictObject, validateAgainst } from "../src/contracts.js";

// The Job's own outputs are checked against the same contract Control
// validates with; the result manifest's verdict/failureCode rule (then/not
// inside allOf) must compile and decide.
describe("contract validation of the Job's outputs", () => {
	const base = {
		schemaVersion: 1,
		launchId: "lch_1",
		attemptId: "att_1",
		jobKind: "validator",
		profileId: "validator-fixed-dev-v1",
		outputs: [
			{
				class: "npm",
				digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
				sizeBytes: "2637",
				handle: "hdl_1",
			},
		],
		completedAt: "2026-09-16T12:00:00Z",
	};
	it("accepts a certified manifest without a failure code and refuses one with it", () => {
		expect(validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, { ...base, verdict: "certified" })).toBeUndefined();
		expect(
			validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, {
				...base,
				verdict: "certified",
				failureCode: "MISSING_CSS",
			}),
		).toBeDefined();
	});
	it("requires a failure code for a failed verdict and refuses unknown output classes", () => {
		expect(
			validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, {
				...base,
				verdict: "repairable",
				failureCode: "MISSING_CSS",
			}),
		).toBeUndefined();
		expect(validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, { ...base, verdict: "repairable" })).toBeDefined();
		expect(
			validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, {
				...base,
				verdict: "certified",
				outputs: [{ ...base.outputs[0], class: "bundle" }],
			}),
		).toBeDefined();
	});
	it("validates a launch envelope and a build-support profile shape", () => {
		expect(
			validateAgainst(`${jobsSchemaId}#/$defs/launchEnvelope`, {
				schemaVersion: 1,
				launchId: "lch_1",
				launchKey: "validator-01j9abc",
				operationId: "op_1",
				attemptId: "att_1",
				profileId: "validator-fixed-dev-v1",
				profileRevision: "1",
				jobKind: "validator",
				executionEpoch: "1",
				launchEpoch: "1",
				deadline: "2026-09-16T12:00:00Z",
				inputs: [],
			}),
		).toBeUndefined();
		expect(validateAgainst(`${componentsSchemaId}#/$defs/buildSupportProfile`, { schemaVersion: 1 })).toBeDefined();
	});
	it("parses strictly: duplicate keys are refused", () => {
		expect(() => parseStrictObject('{"a":1,"a":2}', "doc")).toThrow(/duplicate key/);
		expect(parseStrictObject('{"a":{"b":1},"c":[{"b":2},{"b":3}]}', "doc")).toEqual({
			a: { b: 1 },
			c: [{ b: 2 }, { b: 3 }],
		});
	});
});
