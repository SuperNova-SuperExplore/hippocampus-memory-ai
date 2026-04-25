/**
 * 🧠 Hippocampus — Cross-Session Context Tool
 * 
 * Search memories across ALL sessions for a topic.
 * Groups results by session with metadata.
 */

import { HippocampusDB } from "../database.js";
import { recall } from "./recall.js";
import type { MemoryWithDetails, SessionRecord, CheckpointRecord } from "../types.js";

export interface GetContextInput {
  topic: string;
  max_sessions?: number;
  include_checkpoints?: boolean;
  min_priority?: number;
}

export interface SessionContext {
  session: {
    id: string;
    title: string | null;
    created_at: string;
    last_active: string;
    brain_path: string | null;
  };
  memories: MemoryWithDetails[];
  checkpoints: Array<{
    id: number;
    summary: string;
    created_at: string;
    topics_covered: string[];
    decisions_made: string[];
  }>;
}

export interface GetContextResult {
  topic: string;
  sessions_searched: number;
  sessions_with_results: number;
  total_memories: number;
  contexts: SessionContext[];
}

export function getContext(db: HippocampusDB, input: GetContextInput): GetContextResult {
  const startTime = Date.now();
  const maxSessions = input.max_sessions || 5;
  const includeCheckpoints = input.include_checkpoints !== false;

  if (!input.topic?.trim()) {
    return {
      topic: "",
      sessions_searched: 0,
      sessions_with_results: 0,
      total_memories: 0,
      contexts: [],
    };
  }

  // Search across ALL sessions
  const recallResult = recall(db, {
    query: input.topic,
    session_id: undefined, // null = ALL sessions
    limit: 50,
    min_priority: input.min_priority,
    include_details: true,
  });

  // Group by session
  const sessionMap = new Map<string, MemoryWithDetails[]>();
  for (const r of recallResult.results) {
    const sid = r.memory.session_id;
    if (!sessionMap.has(sid)) {
      sessionMap.set(sid, []);
    }
    sessionMap.get(sid)!.push(r);
  }

  // Build session contexts
  const contexts: SessionContext[] = [];
  let totalMemories = 0;

  // Sort sessions by relevance (number of matching memories)
  const sortedSessions = [...sessionMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxSessions);

  for (const [sessionId, memories] of sortedSessions) {
    // Get session metadata
    const session = db.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRecord | undefined;

    // Get relevant checkpoints
    let checkpoints: Array<{
      id: number;
      summary: string;
      created_at: string;
      topics_covered: string[];
      decisions_made: string[];
    }> = [];

    if (includeCheckpoints) {
      const rawCps = db.db
        .prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 5")
        .all(sessionId) as CheckpointRecord[];

      checkpoints = rawCps.map((cp) => ({
        id: cp.id,
        summary: cp.summary,
        created_at: cp.created_at,
        topics_covered: safeJsonParse(cp.topics_covered, []),
        decisions_made: safeJsonParse(cp.decisions_made, []),
      }));
    }

    totalMemories += memories.length;

    contexts.push({
      session: {
        id: sessionId,
        title: session?.title ?? null,
        created_at: session?.created_at ?? "",
        last_active: session?.last_active ?? "",
        brain_path: session?.brain_path ?? null,
      },
      memories,
      checkpoints,
    });
  }

  // Count total sessions in DB
  const totalSessions = (db.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;

  db.logOperation("get_context", "success", undefined, Date.now() - startTime);

  return {
    topic: input.topic,
    sessions_searched: totalSessions,
    sessions_with_results: contexts.length,
    total_memories: totalMemories,
    contexts,
  };
}

// ═══════════════════════════════════════
// Link Sessions
// ═══════════════════════════════════════

export interface LinkSessionsInput {
  from_session: string;
  to_session: string;
  relationship: "continues" | "references" | "related";
  context?: string;
}

export function linkSessions(db: HippocampusDB, input: LinkSessionsInput) {
  const startTime = Date.now();

  db.ensureSession(input.from_session);
  db.ensureSession(input.to_session);

  const result = db.db
    .prepare(
      `INSERT INTO cross_refs (from_session_id, to_session_id, relationship, context)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.from_session, input.to_session, input.relationship, input.context ?? null);

  db.logOperation("link_sessions", "success", undefined, Date.now() - startTime);

  return {
    cross_ref_id: Number(result.lastInsertRowid),
    message: `Linked ${input.from_session.slice(0, 8)}... → ${input.to_session.slice(0, 8)}... (${input.relationship})`,
  };
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
