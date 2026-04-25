/**
 * 🧠 Hippocampus — Recall Tool
 * 
 * Search memories by query using FTS5 full-text search.
 * Fallback to LIKE if FTS fails.
 * Returns memories with their detail atoms attached.
 */

import { HippocampusDB } from "../database.js";
import type { MemoryRecord, DetailRecord, MemoryWithDetails, RecallResult } from "../types.js";

// ═══════════════════════════════════════
// FTS5 Query Sanitizer
// ═══════════════════════════════════════

function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 special operators that could cause syntax errors
  let sanitized = query
    .replace(/[*"(){}[\]^~\\]/g, " ")  // Remove special chars
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")  // Remove operators
    .replace(/\s+/g, " ")  // Collapse whitespace
    .trim();

  if (!sanitized) return '""';

  // Wrap individual words with quotes for exact matching
  const words = sanitized.split(" ").filter(Boolean);
  if (words.length === 1) {
    return `"${words[0]}"`;
  }
  // Multi-word: combine with OR for broader search
  return words.map((w) => `"${w}"`).join(" OR ");
}

// ═══════════════════════════════════════
// Recall Input
// ═══════════════════════════════════════

export interface RecallInput {
  query: string;
  session_id?: string;
  tags?: string[];
  category?: string;
  limit?: number;
  min_priority?: number;
  include_details?: boolean;
}

// ═══════════════════════════════════════
// Recall Function
// ═══════════════════════════════════════

export function recall(db: HippocampusDB, input: RecallInput): RecallResult {
  const startTime = Date.now();
  const query = input.query?.trim();

  if (!query) {
    return { results: [], total_found: 0, query: "", search_mode: "fts5" };
  }

  const limit = Math.min(Math.max(input.limit || 10, 1), 50);
  const includeDetails = input.include_details !== false; // default true

  let results: MemoryWithDetails[] = [];
  let searchMode: RecallResult["search_mode"] = "fts5";

  // ─── TRY 1: FTS5 search ───
  try {
    results = ftsSearch(db, query, input, limit);
    searchMode = "fts5";
  } catch {
    // ─── TRY 2: LIKE fallback ───
    try {
      results = likeSearch(db, query, input, limit);
      searchMode = "like";
    } catch {
      // ─── TRY 3: Basic fallback ───
      results = basicSearch(db, query, input, limit);
      searchMode = "fallback";
    }
  }

  // Attach details if requested
  if (includeDetails) {
    for (const r of results) {
      r.details = getDetailsForMemory(db, r.memory.id);
    }
  }

  // Attach session titles
  for (const r of results) {
    const session = db.db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(r.memory.session_id) as { title: string | null } | undefined;
    r.session_title = session?.title ?? undefined;
  }

  db.logOperation("recall", "success", undefined, Date.now() - startTime);

  return {
    results,
    total_found: results.length,
    query,
    search_mode: searchMode,
  };
}

// ═══════════════════════════════════════
// FTS5 Search
// ═══════════════════════════════════════

function ftsSearch(
  db: HippocampusDB,
  query: string,
  input: RecallInput,
  limit: number
): MemoryWithDetails[] {
  const ftsQuery = sanitizeFtsQuery(query);

  let sql = `
    SELECT m.*, rank
    FROM memories m
    JOIN memories_fts ON memories_fts.rowid = m.id
    WHERE memories_fts MATCH ?
      AND m.is_active = 1
  `;
  const params: unknown[] = [ftsQuery];

  // Filter by session
  if (input.session_id) {
    sql += " AND m.session_id = ?";
    params.push(input.session_id);
  }

  // Filter by category
  if (input.category) {
    sql += " AND m.category = ?";
    params.push(input.category);
  }

  // Filter by min priority
  if (input.min_priority) {
    sql += " AND m.priority >= ?";
    params.push(input.min_priority);
  }

  // Filter by tags (JSON array contains)
  if (input.tags?.length) {
    for (const tag of input.tags) {
      sql += ` AND m.tags LIKE ?`;
      params.push(`%"${tag}"%`);
    }
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  const rows = db.db.prepare(sql).all(...params) as MemoryRecord[];

  // Also search in details_fts for deeper results
  const detailSql = `
    SELECT DISTINCT d.memory_id
    FROM memory_details d
    JOIN details_fts ON details_fts.rowid = d.id
    WHERE details_fts MATCH ?
    LIMIT ?
  `;
  const detailMatches = db.db.prepare(detailSql).all(ftsQuery, limit) as { memory_id: number }[];

  // Merge results (memory IDs from detail search that aren't already in results)
  const existingIds = new Set(rows.map((r) => r.id));
  const extraIds = detailMatches
    .filter((d) => !existingIds.has(d.memory_id))
    .map((d) => d.memory_id);

  if (extraIds.length > 0) {
    const placeholders = extraIds.map(() => "?").join(",");
    let extraSql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND is_active = 1`;
    const extraParams: unknown[] = [...extraIds];

    if (input.session_id) {
      extraSql += " AND session_id = ?";
      extraParams.push(input.session_id);
    }

    const extraRows = db.db.prepare(extraSql).all(...extraParams) as MemoryRecord[];
    rows.push(...extraRows);
  }

  // Deduplicate
  const seen = new Set<number>();
  const unique = rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  return unique.slice(0, limit).map((m) => ({ memory: m, details: [] }));
}

// ═══════════════════════════════════════
// LIKE Search (Fallback)
// ═══════════════════════════════════════

function likeSearch(
  db: HippocampusDB,
  query: string,
  input: RecallInput,
  limit: number
): MemoryWithDetails[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  let sql = "SELECT * FROM memories WHERE is_active = 1";
  const params: unknown[] = [];

  // Each word must appear in content OR tags
  for (const word of words) {
    sql += " AND (content LIKE ? OR tags LIKE ?)";
    params.push(`%${word}%`, `%${word}%`);
  }

  if (input.session_id) {
    sql += " AND session_id = ?";
    params.push(input.session_id);
  }
  if (input.category) {
    sql += " AND category = ?";
    params.push(input.category);
  }
  if (input.min_priority) {
    sql += " AND priority >= ?";
    params.push(input.min_priority);
  }

  sql += " ORDER BY priority DESC, created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.db.prepare(sql).all(...params) as MemoryRecord[];
  return rows.map((m) => ({ memory: m, details: [] }));
}

// ═══════════════════════════════════════
// Basic Search (Last resort)
// ═══════════════════════════════════════

function basicSearch(
  db: HippocampusDB,
  query: string,
  input: RecallInput,
  limit: number
): MemoryWithDetails[] {
  let sql = "SELECT * FROM memories WHERE is_active = 1 AND content LIKE ?";
  const params: unknown[] = [`%${query}%`];

  if (input.session_id) {
    sql += " AND session_id = ?";
    params.push(input.session_id);
  }

  sql += " ORDER BY priority DESC, created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.db.prepare(sql).all(...params) as MemoryRecord[];
  return rows.map((m) => ({ memory: m, details: [] }));
}

// ═══════════════════════════════════════
// Get Details for a Memory
// ═══════════════════════════════════════

export function getDetailsForMemory(db: HippocampusDB, memoryId: number): DetailRecord[] {
  return db.db
    .prepare("SELECT * FROM memory_details WHERE memory_id = ? ORDER BY detail_type, id")
    .all(memoryId) as DetailRecord[];
}
