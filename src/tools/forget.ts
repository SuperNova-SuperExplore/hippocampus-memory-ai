/**
 * 🧠 Hippocampus — Forget Tool
 * 
 * Soft delete (deactivate) or hard delete a memory.
 */

import { HippocampusDB } from "../database.js";

export interface ForgetInput {
  memory_id: number;
  permanent?: boolean;
}

export function forget(db: HippocampusDB, input: ForgetInput) {
  const startTime = Date.now();

  if (!input.memory_id || input.memory_id < 1) {
    throw new Error("Valid memory_id is required");
  }

  // Check memory exists
  const existing = db.db
    .prepare("SELECT id, session_id FROM memories WHERE id = ?")
    .get(input.memory_id) as { id: number; session_id: string } | undefined;

  if (!existing) {
    return { success: false, message: `Memory #${input.memory_id} not found` };
  }

  if (input.permanent) {
    // Hard delete — cascade deletes details too
    db.db.transaction(() => {
      db.db.prepare("DELETE FROM memory_details WHERE memory_id = ?").run(input.memory_id);
      db.db.prepare("DELETE FROM memories WHERE id = ?").run(input.memory_id);
      db.db
        .prepare("UPDATE sessions SET total_memories = MAX(0, total_memories - 1) WHERE id = ?")
        .run(existing.session_id);
    })();
  } else {
    // Soft delete
    db.db.prepare("UPDATE memories SET is_active = 0 WHERE id = ?").run(input.memory_id);
  }

  db.logOperation("forget", "success", undefined, Date.now() - startTime);

  return {
    success: true,
    memory_id: input.memory_id,
    action: input.permanent ? "permanently_deleted" : "deactivated",
    message: `Memory #${input.memory_id} ${input.permanent ? "permanently deleted" : "deactivated"}`,
  };
}
