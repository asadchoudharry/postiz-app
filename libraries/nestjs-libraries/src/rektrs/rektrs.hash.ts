import { createHash } from 'crypto';

/**
 * REKTRS P3 — canonical content hashing (design P3-1 §2.3).
 *
 * This module is the ONE implementation of the approval hash. The backend,
 * the orchestrator Gate B activity (future slice) and the tests all use these
 * functions — a second implementation anywhere is a defect (design §2.3).
 *
 * Canonical payload per channel variant:
 *   { integrationId, providerIdentifier,
 *     parts: [ { content, delay, image: [ { mediaId, path } ] } ],  // thread order
 *     settings, title, description }
 * publishDate is deliberately NOT part of the payload (rescheduling is a
 * publisher act, not a content change). Tags are NOT protected (design §2.3).
 */

export interface RektrsMediaRef {
  mediaId: string;
  path: string;
}

export interface RektrsVariantPart {
  content: string;
  delay: number;
  image: RektrsMediaRef[];
}

export interface RektrsVariantPayload {
  integrationId: string;
  providerIdentifier: string;
  parts: RektrsVariantPart[];
  settings: unknown;
  title: string | null;
  description: string | null;
}

/** Minimal shape of a Post row needed to build a canonical payload. */
export interface RektrsPostRowLike {
  id: string;
  integrationId: string;
  group: string;
  parentPostId: string | null;
  content: string;
  delay: number;
  /** JSON string of MediaDto[] exactly as stored on Post.image */
  image: string | null;
  /** JSON string exactly as stored on Post.settings */
  settings: string | null;
  title: string | null;
  description: string | null;
  createdAt: Date | string;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonicalisation: recursively sort object keys, keep array order,
 * preserve nulls, drop `undefined` (matches JSON.stringify semantics).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) {
        continue;
      }
      out[key] = canonicalize(inner);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Parse Post.image (JSON string of MediaDto[]) down to {mediaId, path} pairs, in display order. */
export function parseMediaRefs(image: string | null): RektrsMediaRef[] {
  if (!image) {
    return [];
  }
  try {
    const parsed = JSON.parse(image);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry) =>
          entry && typeof entry === 'object' && 'id' in entry && 'path' in entry
      )
      .map((entry) => ({
        mediaId: String((entry as { id: unknown }).id),
        path: String((entry as { path: unknown }).path),
      }));
  } catch {
    return [];
  }
}

/** Parse Post.settings (JSON string) into a value for canonicalisation. Raw string is kept if it is not JSON. */
export function parseSettings(settings: string | null): unknown {
  if (settings === null || settings === undefined || settings === '') {
    return null;
  }
  try {
    return JSON.parse(settings);
  } catch {
    return settings;
  }
}

/**
 * Order the rows of one thread group by walking the parentPostId chain from
 * the root(s). Rows whose parent is missing from the set are treated as
 * additional roots (defensive; should not happen for one group). Any rows
 * left unvisited (cycles) are appended in createdAt order so the result is
 * always total and deterministic.
 */
export function orderThreadParts<T extends RektrsPostRowLike>(rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const row of rows) {
    if (row.parentPostId && byId.has(row.parentPostId)) {
      const siblings = childrenOf.get(row.parentPostId) || [];
      siblings.push(row);
      childrenOf.set(row.parentPostId, siblings);
    } else {
      roots.push(row);
    }
  }
  const byCreated = (a: T, b: T) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  roots.sort(byCreated);
  for (const siblings of childrenOf.values()) {
    siblings.sort(byCreated);
  }
  const ordered: T[] = [];
  const visited = new Set<string>();
  const walk = (row: T) => {
    if (visited.has(row.id)) {
      return;
    }
    visited.add(row.id);
    ordered.push(row);
    for (const child of childrenOf.get(row.id) || []) {
      walk(child);
    }
  };
  for (const root of roots) {
    walk(root);
  }
  if (ordered.length < rows.length) {
    for (const row of [...rows].sort(byCreated)) {
      if (!visited.has(row.id)) {
        ordered.push(row);
      }
    }
  }
  return ordered;
}

/**
 * Build the canonical payload for ONE channel variant from its live Post
 * rows (all rows of one batch for one integration). `settings`, `title` and
 * `description` are save-level fields — they are taken from the thread root
 * (first ordered part), exactly as stored on the Post rows.
 */
export function buildVariantPayload(
  integrationId: string,
  providerIdentifier: string,
  rows: RektrsPostRowLike[]
): RektrsVariantPayload {
  const ordered = orderThreadParts(rows);
  const root = ordered[0];
  return {
    integrationId,
    providerIdentifier,
    parts: ordered.map((row) => ({
      content: row.content,
      delay: row.delay || 0,
      image: parseMediaRefs(row.image),
    })),
    settings: root ? parseSettings(root.settings) : null,
    title: root ? (root.title ?? null) : null,
    description: root ? (root.description ?? null) : null,
  };
}

export function computeVariantHash(payload: RektrsVariantPayload): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Batch hash (design §2.3): SHA-256 over the per-variant hashes sorted by
 * integrationId, joined with the batchId. Exact construction:
 *   sha256hex( batchId + "\n" + sortedVariantHashes.join("\n") )
 */
export function computeBatchHash(
  batchId: string,
  variants: { integrationId: string; contentHash: string }[]
): string {
  const sorted = [...variants].sort((a, b) =>
    a.integrationId < b.integrationId ? -1 : a.integrationId > b.integrationId ? 1 : 0
  );
  return sha256Hex(batchId + '\n' + sorted.map((v) => v.contentHash).join('\n'));
}

/** Request fingerprint for idempotency records (design §3.3). */
export function hashRequestBody(body: unknown): string {
  return sha256Hex(canonicalJson(body ?? null));
}
