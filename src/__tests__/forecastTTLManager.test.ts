import { describe, expect, it } from "vitest";
import { evaluateForecasts } from "../predict/forecastTTLManager.js";

describe("forecastTTLManager", () => {
  it("expires stale entries when liquidationEligible is false even if healthRatioRaw is below 1", () => {
    const nowMs = 1_000_000;
    const [result] = evaluateForecasts(
      [
        {
          key: "obl-1",
          ev: 10,
          hazard: 0.9,
          ttlStr: "unknown",
          forecastUpdatedAtMs: nowMs - 10_000,
          liquidationEligible: false,
          healthRatioRaw: 0.95,
        },
      ],
      {
        forecastMaxAgeMs: 5_000,
        evDropPct: 0.15,
        minEv: 0,
      },
      { nowMs }
    );

    expect(result.expired).toBe(true);
    expect(result.needsRecompute).toBe(true);
    expect(result.reason).toContain("age");
  });
});
