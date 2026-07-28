import { describe, expect, it } from "vitest";
import { ApiError, apiUrl } from "./api";

describe("apiUrl", () => {
  it("prefixes paths with /cf", () => {
    expect(apiUrl("/account-management/v1/me")).toBe("/cf/account-management/v1/me");
  });
  it("normalizes a missing leading slash", () => {
    expect(apiUrl("account-management/v1/me")).toBe("/cf/account-management/v1/me");
  });
});

describe("ApiError", () => {
  it("carries status and body", () => {
    const e = new ApiError(400, { title: "Failed Precondition" });
    expect(e.status).toBe(400);
    expect(e.message).toContain("400");
  });
});
