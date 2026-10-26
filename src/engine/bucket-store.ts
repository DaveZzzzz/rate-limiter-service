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
  private head?: StoredBucket;
  private tail?: StoredBucket;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly maxKeys: number,
    private readonly ttlMs: number,
  ) {}

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

  getOrCreate(key: string, policy: RateLimitPolicy, nowMs: number): StoredBucket {
    const existing = this.buckets.get(key);
    if (existing) {
      existing.lastAccessMs = nowMs;
      this.touch(existing);
      return existing;
    }

    this.evictExpired(nowMs);
    while (this.buckets.size >= this.maxKeys) {
      this.evictLru();
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
    this.pushFront(created);
    return created;
  }

  deleteByTenant(tenantId: string, keySubstring?: string): number {
    let removed = 0;
    for (const bucket of [...this.buckets.values()]) {
      if (bucket.tenantId !== tenantId) {
        continue;
      }
      if (keySubstring && !bucket.key.includes(keySubstring)) {
        continue;
      }
      this.remove(bucket);
      removed += 1;
    }
    return removed;
  }

  activeKeys(tenantId?: string): number {
    if (!tenantId) {
      return this.buckets.size;
    }
    let count = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.tenantId === tenantId) {
        count += 1;
      }
    }
    return count;
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
  }
}
