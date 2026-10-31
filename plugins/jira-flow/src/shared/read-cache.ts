// Deduplicate concurrent reads and briefly reuse successful values. Mutations
// never go through this cache; callers invalidate after writes or explicit sync.
export class ReadCache<T> {
  private entries = new Map<string, { expires: number; promise: Promise<T> }>();
  constructor(
    private ttl: number,
    private limit = 40,
  ) {}
  get(key: string, read: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expires > Date.now()) return current.promise;
    const entry = { expires: Infinity, promise: Promise.resolve().then(read) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.promise.then(
      () => {
        entry.expires = Date.now() + this.ttl;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.promise;
  }
  clear() {
    this.entries.clear();
  }
  delete(key: string) {
    this.entries.delete(key);
  }
}
