import { defineConfig } from "vitest/config";

const enableCoverage = process.env.COVERAGE === "1";

export default defineConfig({
  test: {
    environment: "node",
    ...(enableCoverage && {
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"]
      }
    })
  }
});