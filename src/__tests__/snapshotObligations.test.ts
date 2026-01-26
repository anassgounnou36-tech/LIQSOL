import { describe, it, expect } from "vitest";

/**
 * Test the chunk helper function logic
 */
describe("Chunk helper function", () => {
  function* chunk<T>(arr: T[], size: number): Generator<T[]> {
    for (let i = 0; i < arr.length; i += size) {
      yield arr.slice(i, i + size);
    }
  }

  it("should chunk an array into smaller batches", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const chunks = Array.from(chunk(arr, 3));
    
    expect(chunks).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10]
    ]);
  });

  it("should handle empty arrays", () => {
    const arr: number[] = [];
    const chunks = Array.from(chunk(arr, 3));
    
    expect(chunks).toEqual([]);
  });

  it("should handle arrays smaller than batch size", () => {
    const arr = [1, 2];
    const chunks = Array.from(chunk(arr, 5));
    
    expect(chunks).toEqual([[1, 2]]);
  });

  it("should handle arrays equal to batch size", () => {
    const arr = [1, 2, 3, 4, 5];
    const chunks = Array.from(chunk(arr, 5));
    
    expect(chunks).toEqual([[1, 2, 3, 4, 5]]);
  });
});
