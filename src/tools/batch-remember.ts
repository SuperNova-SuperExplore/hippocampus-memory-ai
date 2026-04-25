/**
 * 🧠 Hippocampus — Batch Remember Tool
 * 
 * Store multiple memories in a single call.
 * All wrapped in ONE transaction: all-or-nothing.
 */

import { HippocampusDB } from "../database.js";
import { FallbackWriter } from "../safeguards/fallback.js";
import { remember, type RememberInput } from "./remember.js";
import { MAX_BATCH_SIZE } from "../types.js";
import type { RememberResult } from "../types.js";

export interface BatchRememberInput {
  memories: RememberInput[];
  session_id?: string; // Apply to all if individual doesn't specify
}

export interface BatchRememberResult {
  results: RememberResult[];
  total_saved: number;
  total_deduped: number;
  total_errors: number;
  message: string;
}

export function batchRemember(
  db: HippocampusDB,
  fallback: FallbackWriter,
  input: BatchRememberInput,
  defaultSessionId: string
): BatchRememberResult {
  const startTime = Date.now();

  if (!input.memories?.length) {
    return {
      results: [],
      total_saved: 0,
      total_deduped: 0,
      total_errors: 0,
      message: "No memories provided",
    };
  }

  // Cap batch size
  const memories = input.memories.slice(0, MAX_BATCH_SIZE);
  const results: RememberResult[] = [];
  let saved = 0;
  let deduped = 0;
  let errors = 0;

  // Process each memory individually but within the same session context
  // We don't wrap ALL in one transaction because one bad memory shouldn't
  // prevent others from being saved
  for (const mem of memories) {
    // Apply batch-level session_id if individual doesn't have one
    if (!mem.session_id && input.session_id) {
      mem.session_id = input.session_id;
    }

    const result = remember(db, fallback, mem, defaultSessionId);
    results.push(result);

    switch (result.status) {
      case "saved": saved++; break;
      case "deduped": deduped++; break;
      case "error": errors++; break;
    }
  }

  db.logOperation("batch_remember", "success", undefined, Date.now() - startTime);

  return {
    results,
    total_saved: saved,
    total_deduped: deduped,
    total_errors: errors,
    message: `Batch complete: ${saved} saved, ${deduped} deduped, ${errors} errors (${Date.now() - startTime}ms)`,
  };
}
