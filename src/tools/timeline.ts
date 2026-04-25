/**
 * 🧠 Hippocampus — Timeline Tool
 * 
 * Chronological view of all memories + checkpoints in a session.
 */

import { HippocampusDB } from "../database.js";
import type { MemoryRecord, CheckpointRecord } from "../types.js";

export interface TimelineInput {
  session_id: string;
  from_time?: string;
  to_time?: string;
  categories?: string[];
  limit?: number;
}

export interface TimelineEntry {
  type: "memory" | "checkpoint";
  id: number;
  timestamp: string;
  content: string;
  category?: string;
  priority?: number;
  tags?: string;
  topics_covered?: string;
  decisions_made?: string;
}

export interface TimelineResult {
  session_id: string;
  session_title: string | null;
  entries: TimelineEntry[];
  total_entries: number;
}

export function timeline(db: HippocampusDB, input: TimelineInput, defaultSessionId: string): TimelineResult {
  const startTime = Date.now();
  const sessionId = input.session_id || defaultSessionId;
  const limit = Math.min(input.limit || 100, 500);

  // Get session title
  const session = db.db
    .prepare("SELECT title FROM sessions WHERE id = ?")
    .get(sessionId) as { title: string | null } | undefined;

  // Fetch memories
  let memSql = "SELECT * FROM memories WHERE session_id = ? AND is_active = 1";
  const memParams: unknown[] = [sessionId];

  if (input.from_time) {
    memSql += " AND created_at >= ?";
    memParams.push(input.from_time);
  }
  if (input.to_time) {
    memSql += " AND created_at <= ?";
    memParams.push(input.to_time);
  }
  if (input.categories?.length) {
    const placeholders = input.categories.map(() => "?").join(",");
    memSql += ` AND category IN (${placeholders})`;
    memParams.push(...input.categories);
  }

  memSql += " ORDER BY created_at ASC";
  const memories = db.db.prepare(memSql).all(...memParams) as MemoryRecord[];

  // Fetch checkpoints
  let cpSql = "SELECT * FROM checkpoints WHERE session_id = ?";
  const cpParams: unknown[] = [sessionId];

  if (input.from_time) {
    cpSql += " AND created_at >= ?";
    cpParams.push(input.from_time);
  }
  if (input.to_time) {
    cpSql += " AND created_at <= ?";
    cpParams.push(input.to_time);
  }

  cpSql += " ORDER BY created_at ASC";
  const checkpoints = db.db.prepare(cpSql).all(...cpParams) as CheckpointRecord[];

  // Merge into timeline
  const entries: TimelineEntry[] = [];

  for (const m of memories) {
    entries.push({
      type: "memory",
      id: m.id,
      timestamp: m.created_at,
      content: m.content,
      category: m.category,
      priority: m.priority,
      tags: m.tags,
    });
  }

  for (const cp of checkpoints) {
    entries.push({
      type: "checkpoint",
      id: cp.id,
      timestamp: cp.created_at,
      content: cp.summary,
      topics_covered: cp.topics_covered,
      decisions_made: cp.decisions_made,
    });
  }

  // Sort by timestamp
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Apply limit
  const limited = entries.slice(0, limit);

  db.logOperation("timeline", "success", undefined, Date.now() - startTime);

  return {
    session_id: sessionId,
    session_title: session?.title ?? null,
    entries: limited,
    total_entries: entries.length,
  };
}
