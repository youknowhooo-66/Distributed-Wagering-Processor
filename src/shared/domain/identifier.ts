import { v7 as uuidv7 } from 'uuid';

/**
 * Generates a UUID v7 (timestamp-ordered) identifier.
 * UUID v7 provides natural chronological ordering in B-tree indexes,
 * which is beneficial for both queries and storage locality.
 */
export function generateId(): string {
  return uuidv7();
}
