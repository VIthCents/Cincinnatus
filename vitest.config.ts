import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Run the whole suite in a deliberately hostile timezone (UTC+14).
    //
    // Date handling bugs — parsing a date-only string as local midnight instead
    // of UTC, for example — are invisible on CI because CI is UTC. Under
    // Kiritimati they are off by a full day, in the direction that makes a job
    // posted "today" look like it was posted tomorrow.
    env: { TZ: "Pacific/Kiritimati" },
    reporters: "dot",
  },
});
