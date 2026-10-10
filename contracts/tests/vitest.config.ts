import { defineConfig } from "vitest/config";
import { NameSequencer } from "./sequencer.js";

// Suites share server state (sessions, the RAG knowledge base), so files run
// one at a time in file-name order (00-…, 10-…, …, 90-metrics last).
export default defineConfig({
  test: {
    include: ["suites/**/*.test.ts"],
    fileParallelism: false,
    sequence: { sequencer: NameSequencer, concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    reporters: ["verbose"],
  },
});
