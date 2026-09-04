import crypto from "node:crypto";

export class ExpiringTokenStore {
  constructor({ ttlMs, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.records = new Map();
  }

  issue(value, ttlMs = this.ttlMs) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.records.set(token, { value, expiresAt: this.now() + ttlMs });
    return token;
  }

  get(token) {
    const record = this.records.get(token);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.records.delete(token);
      return null;
    }
    return record.value;
  }

  consume(token) {
    const value = this.get(token);
    this.records.delete(token);
    return value;
  }

  sweep() {
    for (const [token, record] of this.records) {
      if (record.expiresAt <= this.now()) this.records.delete(token);
    }
  }
}
