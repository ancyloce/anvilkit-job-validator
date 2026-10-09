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
		profileId: "validator-source-dev-v1",
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
	it("names the identity refusal in a failed manifest", () => {
		expect(
			validateAgainst(`${jobsSchemaId}#/$defs/resultManifest`, {
				...base,
				outputs: [],
				verdict: "invalid",
				failureCode: "IDENTITY_MISMATCH",
			}),
		).toBeUndefined();
	});
	it("validates a launch envelope, its allocated component identity and a build-support profile shape", () => {
		const envelope = {
			schemaVersion: 1,
			launchId: "lch_1",
			launchKey: "validator-01j9abc",
			operationId: "op_1",
			attemptId: "att_1",
			profileId: "validator-fixture-v1",
			profileRevision: "1",
			jobKind: "validator",
			executionEpoch: "1",
			launchEpoch: "1",
			deadline: "2026-09-16T12:00:00Z",
			inputs: [],
		};
		const component = {
			componentId: "cmp_hero_fixed",
			puckType: "Hero",
			packageName: "@anvilkit/hero-fixed",
			sourceRevision: "42",
		};
		expect(validateAgainst(`${jobsSchemaId}#/$defs/launchEnvelope`, envelope)).toBeUndefined();
		expect(validateAgainst(`${jobsSchemaId}#/$defs/launchEnvelope`, { ...envelope, component })).toBeUndefined();
		// All four facts are required, and nothing else is accepted.
		const { sourceRevision: _omitted, ...partial } = component;
		expect(validateAgainst(`${jobsSchemaId}#/$defs/launchEnvelope`, { ...envelope, component: partial })).toBeDefined();
		expect(
			validateAgainst(`${jobsSchemaId}#/$defs/launchEnvelope`, { ...envelope, component: { ...component, extra: 1 } }),
		).toBeDefined();
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
