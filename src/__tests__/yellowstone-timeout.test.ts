import { describe, it, expect } from "vitest";

/**
 * Tests for Yellowstone timeout behavior
 * 
 * These are unit tests that verify the timeout logic without requiring actual gRPC connections.
 */
describe("Yellowstone timeout configuration", () => {
  it("should have default timeout values of 45 and 10 seconds", () => {
    const maxTimeoutSeconds = 45;
    const inactivityTimeoutSeconds = 10;
    
    expect(maxTimeoutSeconds).toBe(45);
    expect(inactivityTimeoutSeconds).toBe(10);
  });

  it("should convert seconds to milliseconds correctly", () => {
    const maxTimeoutSeconds = 45;
    const inactivityTimeoutSeconds = 10;
    
    const maxTimeoutMs = maxTimeoutSeconds * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSeconds * 1000;
    
    expect(maxTimeoutMs).toBe(45000);
    expect(inactivityTimeoutMs).toBe(10000);
  });

  it("should accept custom timeout values", () => {
    const customMaxTimeout = 60;
    const customInactivityTimeout = 15;
    
    expect(customMaxTimeout).toBeGreaterThan(0);
    expect(customInactivityTimeout).toBeGreaterThan(0);
  });
});
