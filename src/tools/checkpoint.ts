/**
 * 🧠 Hippocampus — Checkpoint Tool
 * 
 * Save a progress snapshot of the current session.
 * Like a "save game" — captures current state.
 */

import { HippocampusDB } from "../database.js";

export interface CheckpointInput {
  session_id: string;
  summary: string;
  topics_covered?: string[];
  decisions_made?: string[];
  open_questions?: string[];
}

export interface CheckpointResult {
  checkpoint_id: number;
  session_id: string;
  memory_count: number;
  message: string;
}

export function checkpoint(db: HippocampusDB, input: CheckpointInput, defaultSessionId: string): CheckpointResult {
  const startTime = Date.now();
  const sessionId = input.session_id || defaultSessionId;

  if (!input.summary?.trim()) {
    throw new Error("Checkpoint summary is required");
  }

  db.ensureSession(sessionId);

  const result = db.db.transaction(() => {
    // Count current memories for this session
    const countRow = db.db
      .prepare("SELECT COUNT(*) as c FROM memories WHERE session_id = ? AND is_active = 1")
      .get(sessionId) as { c: number };

    const memoryCount = countRow.c;

    // Insert checkpoint
    const cpResult = db.db
      .prepare(
        `INSERT INTO checkpoints (session_id, summary, topics_covered, decisions_made, open_questions, memory_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        input.summary.trim(),
        JSON.stringify(input.topics_covered || []),
        JSON.stringify(input.decisions_made || []),
        JSON.stringify(input.open_questions || []),
        memoryCount
      );

    // Update session
    db.db
      .prepare("UPDATE sessions SET total_checkpoints = total_checkpoints + 1, last_active = datetime('now') WHERE id = ?")
      .run(sessionId);

    return {
      checkpointId: Number(cpResult.lastInsertRowid),
      memoryCount,
    };
  })();

  db.incrementWriteCount();
  db.logOperation("checkpoint", "success", undefined, Date.now() - startTime);

  return {
    checkpoint_id: result.checkpointId,
    session_id: sessionId,
    memory_count: result.memoryCount,
    message: `Checkpoint #${result.checkpointId} saved (${result.memoryCount} memories at this point)`,
  };
}

/**
 * Get the latest checkpoint for a session
 */
export function getLatestCheckpoint(db: HippocampusDB, sessionId: string) {
  return db.db
    .prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(sessionId);
}
