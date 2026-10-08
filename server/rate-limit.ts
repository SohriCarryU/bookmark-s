import { ApiError } from './errors.js'

interface Limit { key: string; max: number; seconds: number }
interface Bucket { count: number; expires: number }

export class RateLimitError extends ApiError {
  constructor(public retryAfter: number) { super('操作有点频繁，请稍后再试', 429) }
}

/** Reservations also count in-flight logins, so concurrent checks cannot overshoot. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private nextCleanup = 0

  reserve(limits: Limit[]) {
    const now = Date.now()
    if (now >= this.nextCleanup) {
      for (const [key, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(key)
      this.nextCleanup = now + 60_000
    }
    const selected = limits.map(limit => {
      const existing = this.buckets.get(limit.key)
      const bucket = existing && existing.expires > now ? existing : { count: 0, expires: now + limit.seconds * 1000 }
      return { ...limit, bucket }
    })
    const blocked = selected.filter(limit => limit.bucket.count >= limit.max)
    if (blocked.length) throw new RateLimitError(Math.max(...blocked.map(limit => Math.ceil((limit.bucket.expires - now) / 1000))))
    // Do not evict live IP buckets when browsers or account names rotate.
    if (this.buckets.size + selected.filter(limit => !this.buckets.has(limit.key)).length > 10_000) throw new RateLimitError(60)
    for (const { key, bucket } of selected) {
      bucket.count++
      this.buckets.set(key, bucket)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const { key, bucket } of selected) {
        if (this.buckets.get(key) !== bucket) continue
        if (--bucket.count === 0) this.buckets.delete(key)
      }
    }
  }
}
