import { describe, it, expect } from "vitest";
import { getErrorMessage, sleep } from "./utils.js";

describe("getErrorMessage", () => {
  it("returns the message of an Error", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string errors as-is", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
  });

  it("returns .message from error-like objects", () => {
    expect(getErrorMessage({ message: "oops" })).toBe("oops");
  });

  it("falls back to toString when there is no message", () => {
    expect(getErrorMessage({ toString: () => "stringified" })).toBe(
      "stringified",
    );
  });

  it("returns a sentinel for null/undefined", () => {
    expect(getErrorMessage(null)).toBe("Unknown error");
    expect(getErrorMessage(undefined)).toBe("Unknown error");
  });
});

describe("sleep", () => {
  it("resolves after the given milliseconds", async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });
});
