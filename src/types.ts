/**
 * 🧠 Hippocampus — Shared type definitions
 */

// ═══════════════════════════════════════
// Detail Atom Types
// ═══════════════════════════════════════

export type DetailType =
  | "file"
  | "function"
  | "dependency"
  | "config"
  | "command"
  | "value"
  | "error"
  | "endpoint"
  | "schema"
  | "reference";

export interface DetailAtom {
  type: DetailType;
  name?: string;
  value?: string;
  context?: string;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════
// Memory Categories
// ═══════════════════════════════════════

export type MemoryCategory =
  | "decision"
  | "finding"
  | "instruction"
  | "code"
  | "error"
  | "architecture"
  | "general";

// ═══════════════════════════════════════
// Trigger Types
// ═══════════════════════════════════════

export type TriggerType =
  | "DECISION_MADE"
  | "FINDING_DISCOVERED"
  | "USER_INSTRUCTION"
  | "CODE_CHANGE"
  | "ERROR_FOUND"
  | "ARCHITECTURE_DECISION"
  | "TOPIC_CHANGE"
  | "SESSION_START"
  | "SESSION_END"
  | "MANUAL";

// ═══════════════════════════════════════
// Memory Record (from DB)
// ═══════════════════════════════════════

export interface MemoryRecord {
  id: number;
  session_id: string;
  content: string;
  tags: string;
  category: string;
  priority: number;
  trigger_type: string | null;
  source_step_index: number | null;
  created_at: string;
  expires_at: string | null;
  is_active: number;
}

export interface DetailRecord {
  id: number;
  memory_id: number;
  detail_type: string;
  name: string | null;
  value: string | null;
  context: string | null;
  metadata: string;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  title: string | null;
  title_auto_generated: number;
  brain_path: string | null;
  overview_path: string | null;
  first_message: string | null;
  created_at: string;
  last_active: string;
  total_memories: number;
  total_checkpoints: number;
  status: string;
}

export interface CheckpointRecord {
  id: number;
  session_id: string;
  summary: string;
  topics_covered: string;
  decisions_made: string;
  open_questions: string;
  memory_count: number;
  created_at: string;
}

// ═══════════════════════════════════════
// API Response Types
// ═══════════════════════════════════════

export interface MemoryWithDetails {
  memory: MemoryRecord;
  details: DetailRecord[];
  session_title?: string;
}

export interface RememberResult {
  memory_id: number;
  detail_ids: number[];
  status: "saved" | "deduped" | "error";
  message: string;
}

export interface RecallResult {
  results: MemoryWithDetails[];
  total_found: number;
  query: string;
  search_mode: "fts5" | "like" | "fallback";
}

// ═══════════════════════════════════════
// Validation Constants
// ═══════════════════════════════════════

export const MAX_CONTENT_LENGTH = 10_000;
export const MAX_BATCH_SIZE = 50;
export const VALID_CATEGORIES: MemoryCategory[] = [
  "decision", "finding", "instruction", "code", "error", "architecture", "general"
];
export const VALID_DETAIL_TYPES: DetailType[] = [
  "file", "function", "dependency", "config", "command", "value", "error", "endpoint", "schema", "reference"
];
