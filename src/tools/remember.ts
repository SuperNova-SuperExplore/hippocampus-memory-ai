/**
 * 🧠 Hippocampus — Remember Tool
 * 
 * Store a memory with optional detail atoms.
 * Transaction-wrapped: all-or-nothing.
 * With retry + fallback safety net.
 */

import { HippocampusDB } from "../database.js";
import { FallbackWriter } from "../safeguards/fallback.js";
import type {
  DetailAtom,
  MemoryCategory,
  RememberResult,
  VALID_CATEGORIES,
  VALID_DETAIL_TYPES,
  MAX_CONTENT_LENGTH,
} from "../types.js";

// ═══════════════════════════════════════
// Input Validation
// ═══════════════════════════════════════

function validateTags(tags: unknown): string {
  if (!tags) return "[]";
  if (Array.isArray(tags)) return JSON.stringify(tags);
  if (typeof tags === "string") {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch { /* ignore */ }
    // Single tag as string
    return JSON.stringify([tags]);
  }
  return "[]";
}

function validateCategory(category: unknown): string {
  const valid = ["decision", "finding", "instruction", "code", "error", "architecture", "general"];
  if (typeof category === "string" && valid.includes(category)) return category;
  return "general";
}

function validatePriority(priority: unknown): number {
  const p = Number(priority);
  if (isNaN(p) || p < 1) return 3;
  if (p > 5) return 5;
  return Math.round(p);
}

function validateContent(content: unknown): string {
  if (!content || typeof content !== "string" || !content.trim()) {
    throw new Error("Content is required and cannot be empty");
  }
  const trimmed = content.trim();
  if (trimmed.length > 10_000) {
    return trimmed.substring(0, 10_000) + "\n[TRUNCATED — original length: " + trimmed.length + " chars]";
  }
  return trimmed;
}

function validateMetadata(metadata: unknown): string {
  if (!metadata) return "{}";
  if (typeof metadata === "string") {
    try { JSON.parse(metadata); return metadata; } catch { return "{}"; }
  }
  if (typeof metadata === "object") {
    try { return JSON.stringify(metadata); } catch { return "{}"; }
  }
  return "{}";
}

// ═══════════════════════════════════════
// Remember Function
// ═══════════════════════════════════════

export interface RememberInput {
  content: string;
  session_id?: string;
  tags?: string[] | string;
  category?: string;
  priority?: number;
  trigger_type?: string;
  details?: DetailAtom[];
  skip_dedup?: boolean;
}

export function remember(
  db: HippocampusDB,
  fallback: FallbackWriter,
  input: RememberInput,
  defaultSessionId: string
): RememberResult {
  const startTime = Date.now();

  try {
    // Validate inputs
    const content = validateContent(input.content);
    const sessionId = input.session_id || defaultSessionId;
    const tags = validateTags(input.tags);
    const category = validateCategory(input.category);
    const priority = validatePriority(input.priority);
    const triggerType = input.trigger_type || "MANUAL";
    const details = input.details || [];

    // Ensure session exists
    db.ensureSession(sessionId);

    // Optional dedup check
    if (!input.skip_dedup) {
      const isDup = checkDuplicate(db, sessionId, content);
      if (isDup) {
        db.logOperation("remember", "deduped", undefined, Date.now() - startTime);
        return {
          memory_id: isDup,
          detail_ids: [],
          status: "deduped",
          message: `Similar memory already exists (id: ${isDup}). Use skip_dedup=true to force save.`,
        };
      }
    }

    // Transaction: insert memory + all details atomically
    const result = db.db.transaction(() => {
      // Insert memory
      const memResult = db.db
        .prepare(
          `INSERT INTO memories (session_id, content, tags, category, priority, trigger_type)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(sessionId, content, tags, category, priority, triggerType);

      const memoryId = Number(memResult.lastInsertRowid);
      const detailIds: number[] = [];

      // Insert detail atoms
      const detailStmt = db.db.prepare(
        `INSERT INTO memory_details (memory_id, detail_type, name, value, context, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      for (const detail of details) {
        if (!detail.type) continue;

        const validTypes = ["file", "function", "dependency", "config", "command", "value", "error", "endpoint", "schema", "reference"];
        if (!validTypes.includes(detail.type)) continue;

        const detResult = detailStmt.run(
          memoryId,
          detail.type,
          detail.name ?? null,
          detail.value ?? null,
          detail.context ?? null,
          validateMetadata(detail.metadata)
        );
        detailIds.push(Number(detResult.lastInsertRowid));
      }

      // Update session stats
      db.db
        .prepare("UPDATE sessions SET total_memories = total_memories + 1, last_active = datetime('now') WHERE id = ?")
        .run(sessionId);

      return { memoryId, detailIds };
    })();

    // Track write for auto-backup
    db.incrementWriteCount();

    // Log success
    db.logOperation("remember", "success", undefined, Date.now() - startTime);

    return {
      memory_id: result.memoryId,
      detail_ids: result.detailIds,
      status: "saved",
      message: `Memory #${result.memoryId} saved with ${result.detailIds.length} detail(s)`,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // RETRY once
    try {
      return retryRemember(db, input, defaultSessionId, startTime);
    } catch {
      // FALLBACK to file
      fallback.write("remember", input as unknown as Record<string, unknown>);
      db.logOperation("remember", "fallback", errMsg, Date.now() - startTime);

      return {
        memory_id: -1,
        detail_ids: [],
        status: "error",
        message: `DB write failed, saved to fallback file. Error: ${errMsg}`,
      };
    }
  }
}

// ═══════════════════════════════════════
// Dedup Check
// ═══════════════════════════════════════

function checkDuplicate(db: HippocampusDB, sessionId: string, content: string): number | false {
  try {
    // Use first 100 chars as search key for performance
    const searchKey = content.substring(0, 100).replace(/['"*()]/g, " ");

    const results = db.db
      .prepare(
        `SELECT m.id, m.content FROM memories m
         JOIN memories_fts ON memories_fts.rowid = m.id
         WHERE memories_fts MATCH ? AND m.session_id = ? AND m.is_active = 1
         LIMIT 5`
      )
      .all(searchKey, sessionId) as { id: number; content: string }[];

    for (const row of results) {
      // Simple similarity: check if >90% of words overlap
      const newWords = new Set(content.toLowerCase().split(/\s+/));
      const oldWords = new Set(row.content.toLowerCase().split(/\s+/));
      const intersection = [...newWords].filter((w) => oldWords.has(w));
      const similarity = intersection.length / Math.max(newWords.size, oldWords.size);

      if (similarity > 0.9) return row.id;
    }
  } catch {
    // If dedup check fails, proceed with save (better safe than sorry)
  }

  return false;
}

// ═══════════════════════════════════════
// Retry Logic
// ═══════════════════════════════════════

function retryRemember(
  db: HippocampusDB,
  input: RememberInput,
  defaultSessionId: string,
  startTime: number
): RememberResult {
  const content = validateContent(input.content);
  const sessionId = input.session_id || defaultSessionId;
  const tags = validateTags(input.tags);
  const category = validateCategory(input.category);
  const priority = validatePriority(input.priority);

  db.ensureSession(sessionId);

  const result = db.db.transaction(() => {
    const memResult = db.db
      .prepare(
        `INSERT INTO memories (session_id, content, tags, category, priority, trigger_type)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, content, tags, category, priority, input.trigger_type || "MANUAL");

    const memoryId = Number(memResult.lastInsertRowid);
    const detailIds: number[] = [];

    // Retry without details if they caused the issue
    if (input.details?.length) {
      try {
        const detailStmt = db.db.prepare(
          `INSERT INTO memory_details (memory_id, detail_type, name, value, context, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const d of input.details) {
          if (!d.type) continue;
          const r = detailStmt.run(memoryId, d.type, d.name ?? null, d.value ?? null, d.context ?? null, validateMetadata(d.metadata));
          detailIds.push(Number(r.lastInsertRowid));
        }
      } catch {
        // Details failed on retry — save memory without details
      }
    }

    db.db.prepare("UPDATE sessions SET total_memories = total_memories + 1, last_active = datetime('now') WHERE id = ?").run(sessionId);

    return { memoryId, detailIds };
  })();

  db.incrementWriteCount();
  db.logOperation("remember", "retry_success", undefined, Date.now() - startTime);

  return {
    memory_id: result.memoryId,
    detail_ids: result.detailIds,
    status: "saved",
    message: `Memory #${result.memoryId} saved on retry with ${result.detailIds.length} detail(s)`,
  };
}
