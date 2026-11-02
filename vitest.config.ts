import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		// The build and host checks spawn real processes (Rollup, the SSR
		// script, a Chromium page); they are not parallel-safe: they share the
		// fixture directories.
		fileParallelism: false,
	},
});
