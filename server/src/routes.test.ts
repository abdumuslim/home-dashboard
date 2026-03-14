import { describe, it, expect } from "vitest";
import { median } from "./routes.js";

describe("median", () => {
  it("returns the middle value for odd-length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });

  it("returns the average of two middle values for even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 3])).toBe(2);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("handles arrays with duplicate values", () => {
    expect(median([5, 5, 5])).toBe(5);
    expect(median([1, 1, 2, 2])).toBe(1.5);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("handles negative numbers", () => {
    expect(median([-3, -1, -2])).toBe(-2);
    expect(median([-10, 0, 10])).toBe(0);
  });
});
