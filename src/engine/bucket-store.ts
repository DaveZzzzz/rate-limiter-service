import { getAlgorithm } from "../algorithms/index.js";
import type { RateLimitPolicy } from "../types.js";

export interface StoredBucket {
  key: string;
  tenantId: string;
  policyId: string;
  state: unknown;
  lastAccessMs: number;
  prev?: StoredBucket;
  next?: StoredBucket;
}

const ESTIMATED_BYTES_PER_BUCKET = 256;

export class BucketStore {
  private readonly buckets = new Map<string, StoredBucket>();
  private readonly tenantCounts = new Map<string, number>();
  private head?: StoredBucket;
  private tail?: StoredBucket;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly maxKeys: number,
    private readonly ttlMs: number,
  ) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error("maxKeys must be a positive integer");
    }
  }

  startSweep(intervalMs: number, now: () => number): void {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      this.evictExpired(now());
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  get(key: string): StoredBucket | undefined {
    return this.buckets.get(key);
  }

  touchExisting(key: string, nowMs: number): StoredBucket | undefined {
    const existing = this.buckets.get(key);
    if (!existing) {
      return undefined;
    }
    existing.lastAccessMs = nowMs;
    this.touch(existing);
    return existing;
  }

  getOrCreate(key: string, policy: RateLimitPolicy, nowMs: number): StoredBucket {
    const existing = this.buckets.get(key);
    if (existing) {
      existing.lastAccessMs = nowMs;
      this.touch(existing);
      return existing;
    }

    this.evictExpired(nowMs);
    while (this.buckets.size >= this.maxKeys) {
      const before = this.buckets.size;
      this.evictLru();
      if (this.buckets.size >= before) {
        break;
      }
    }

    const algorithm = getAlgorithm(policy);
    const created: StoredBucket = {
      key,
      tenantId: policy.tenantId,
      policyId: policy.id,
      state: algorithm.createState(policy, nowMs),
      lastAccessMs: nowMs,
    };
    this.buckets.set(key, created);
    this.tenantCounts.set(policy.tenantId, (this.tenantCounts.get(policy.tenantId) ?? 0) + 1);
    this.pushFront(created);
    return created;
  }

  deleteByTenant(tenantId: string, keySubstring?: string): number {
    let removed = 0;
    let cursor = this.head;
    while (cursor) {
      const next = cursor.next;
      if (cursor.tenantId === tenantId && (!keySubstring || cursor.key.includes(keySubstring))) {
        this.remove(cursor);
        removed += 1;
      }
      cursor = next;
    }
    return removed;
  }

  activeKeys(tenantId?: string): number {
    if (!tenantId) {
      return this.buckets.size;
    }
    return this.tenantCounts.get(tenantId) ?? 0;
  }

  estimatedBytes(tenantId?: string): number {
    return this.activeKeys(tenantId) * ESTIMATED_BYTES_PER_BUCKET;
  }

  evictExpired(nowMs: number): number {
    let removed = 0;
    let cursor = this.tail;
    while (cursor) {
      const prev = cursor.prev;
      if (nowMs - cursor.lastAccessMs >= this.ttlMs) {
        this.remove(cursor);
        removed += 1;
      } else {
        break;
      }
      cursor = prev;
    }
    return removed;
  }

  private evictLru(): void {
    if (this.tail) {
      this.remove(this.tail);
    }
  }

  private touch(bucket: StoredBucket): void {
    if (this.head === bucket) {
      return;
    }
    this.detach(bucket);
    this.pushFront(bucket);
  }

  private pushFront(bucket: StoredBucket): void {
    bucket.prev = undefined;
    bucket.next = this.head;
    if (this.head) {
      this.head.prev = bucket;
    }
    this.head = bucket;
    if (!this.tail) {
      this.tail = bucket;
    }
  }

  private detach(bucket: StoredBucket): void {
    if (bucket.prev) {
      bucket.prev.next = bucket.next;
    }
    if (bucket.next) {
      bucket.next.prev = bucket.prev;
    }
    if (this.head === bucket) {
      this.head = bucket.next;
    }
    if (this.tail === bucket) {
      this.tail = bucket.prev;
    }
    bucket.prev = undefined;
    bucket.next = undefined;
  }

  private remove(bucket: StoredBucket): void {
    this.detach(bucket);
    this.buckets.delete(bucket.key);
    const remaining = (this.tenantCounts.get(bucket.tenantId) ?? 1) - 1;
    if (remaining <= 0) {
      this.tenantCounts.delete(bucket.tenantId);
    } else {
      this.tenantCounts.set(bucket.tenantId, remaining);
    }
  }
}
