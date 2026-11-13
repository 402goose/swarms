export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    nowMs = Date.now(),
  ) {
    this.capacity = Math.max(0, capacity);
    this.refillPerSecond = Math.max(0, refillPerSecond);
    this.tokens = this.capacity;
    this.lastRefillMs = nowMs;
  }

  tryTake(cost = 1, nowMs = Date.now()): boolean {
    const amount = Math.max(0, cost);
    const elapsedSeconds = Math.max(0, nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = Math.max(this.lastRefillMs, nowMs);
    if (amount > this.tokens) return false;
    this.tokens -= amount;
    return true;
  }
}

export class KeyedTokenBuckets {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys = 10_000,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  tryTake(key: string, cost = 1, nowMs = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, nowMs);
      this.buckets.set(key, bucket);
      while (this.buckets.size > Math.max(1, this.maxKeys)) {
        const oldest = this.buckets.keys().next().value as string | undefined;
        if (!oldest || oldest === key) break;
        this.buckets.delete(oldest);
      }
    } else {
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }
    return bucket.tryTake(cost, nowMs);
  }
}

export function boundedIntFromEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!origin) return true;
  const normalized = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return allowedOrigins.has(normalized);
}
