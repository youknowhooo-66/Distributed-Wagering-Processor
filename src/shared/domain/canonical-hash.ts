import { createHash } from 'node:crypto';

/**
 * Serializes any JavaScript object into canonical JSON:
 * - Object keys are sorted lexicographically at all levels
 * - Arrays preserve their order
 * - undefined and null values are handled deterministically
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalizeJson(item)).join(',')}]`;
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries: string[] = [];

  for (const key of sortedKeys) {
    const val = record[key];
    if (val !== undefined) {
      entries.push(`${JSON.stringify(key)}:${canonicalizeJson(val)}`);
    }
  }

  return `{${entries.join(',')}}`;
}

/**
 * Computes a SHA-256 hash of the canonical JSON string.
 */
export function computePayloadHash(data: unknown): string {
  const canonicalString = canonicalizeJson(data);
  return createHash('sha256').update(canonicalString).digest('hex');
}
