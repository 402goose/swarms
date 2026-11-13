import { describe, expect, it } from "vitest";
import {
  boundedIntFromEnv,
  isOriginAllowed,
  KeyedTokenBuckets,
  TokenBucket,
} from "../apps/server/src/rate-limit.ts";

describe("server edge budgets", () => {
  it("refills a token bucket deterministically without exceeding capacity", () => {
    const bucket = new TokenBucket(3, 2, 1_000);
    expect(bucket.tryTake(2, 1_000)).toBe(true);
    expect(bucket.tryTake(2, 1_250)).toBe(false);
    expect(bucket.tryTake(1, 1_500)).toBe(true);
    expect(bucket.tryTake(10, 100_000)).toBe(false);
    expect(bucket.tryTake(3, 100_000)).toBe(true);
  });

  it("isolates keyed buckets and bounds tracked keys", () => {
    const limiter = new KeyedTokenBuckets(1, 0, 2);
    expect(limiter.tryTake("a", 1, 0)).toBe(true);
    expect(limiter.tryTake("a", 1, 0)).toBe(false);
    expect(limiter.tryTake("b", 1, 0)).toBe(true);
    expect(limiter.tryTake("c", 1, 0)).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it("parses bounded integer configuration and checks browser origins", () => {
    expect(boundedIntFromEnv(undefined, 64, 1, 256)).toBe(64);
    expect(boundedIntFromEnv("12.9", 64, 1, 256)).toBe(12);
    expect(boundedIntFromEnv("9999", 64, 1, 256)).toBe(256);
    expect(boundedIntFromEnv("nope", 64, 1, 256)).toBe(64);
    const allowed = new Set(["http://127.0.0.1:15173"]);
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:15173/", allowed)).toBe(true);
    expect(isOriginAllowed("https://evil.example", allowed)).toBe(false);
  });
});
