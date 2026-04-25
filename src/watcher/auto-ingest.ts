/**
 * 🧠 Hippocampus — Auto-Ingest Watcher
 * 
 * Monitors Antigravity brain/ directory for overview.txt changes.
 * Auto-parses JSONL entries and stores memories without AI involvement.
 * Session ID is derived from the directory name (UUID).
 */

import fs from "fs";
import path from "path";
import { HippocampusDB } from "../database.js";

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface OverviewEntry {
  step_index: number;
  source: string;       // "USER_EXPLICIT" | "MODEL"
  type: string;         // "USER_INPUT" | "PLANNER_RESPONSE"
  status: string;
  created_at: string;
  content: string;
  tool_calls?: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
}

interface WatcherState {
  session_id: string;
  overview_path: string;
  last_byte_offset: number;
  last_step_index: number;
  entries_ingested: number;
}

// UUID pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════
// Auto-Ingest Watcher Class
// ═══════════════════════════════════════

export class AutoIngestWatcher {
  private db: HippocampusDB;
  private brainPath: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private scanIntervalMs: number;

  constructor(db: HippocampusDB, brainPath: string, scanIntervalMs = 10_000) {
    this.db = db;
    this.brainPath = brainPath;
    this.scanIntervalMs = scanIntervalMs;
  }

  /**
   * Start the background watcher
   */
  start(): void {
    if (!this.brainPath || !fs.existsSync(this.brainPath)) {
      console.error(`[AutoIngest] Brain path not found: ${this.brainPath}`);
      return;
    }

    console.error(`[AutoIngest] Started — scanning ${this.brainPath} every ${this.scanIntervalMs / 1000}s`);

    // Initial scan
    this.scan();

    // Periodic scan
    this.intervalId = setInterval(() => this.scan(), this.scanIntervalMs);
  }

  /**
   * Stop the background watcher
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.error("[AutoIngest] Stopped");
    }
  }

  /**
   * Scan for recently modified overview.txt files
   */
  private scan(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      const entries = fs.readdirSync(this.brainPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!UUID_REGEX.test(entry.name)) continue;

        const sessionId = entry.name;
        const overviewPath = path.join(
          this.brainPath, sessionId,
          ".system_generated", "logs", "overview.txt"
        );

        if (!fs.existsSync(overviewPath)) continue;

        // Check if file was modified recently (last 60 seconds)
        try {
          const stat = fs.statSync(overviewPath);
          const ageSec = (now - stat.mtimeMs) / 1000;
          if (ageSec > 60) continue; // Skip old files
        } catch {
          continue;
        }

        // Process this file
        this.processOverview(sessionId, overviewPath);
      }
    } catch (err) {
      // Silent fail — watcher should never crash the server
      console.error(`[AutoIngest] Scan error: ${err}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process new entries from an overview.txt file
   */
  private processOverview(sessionId: string, overviewPath: string): void {
    // Get or create watcher state
    let state = this.db.db
      .prepare("SELECT * FROM watcher_state WHERE session_id = ?")
      .get(sessionId) as WatcherState | undefined;

    if (!state) {
      // First time seeing this file — start from current position
      // (don't re-process history, only capture NEW entries)
      const stat = fs.statSync(overviewPath);
      this.db.db
        .prepare(
          `INSERT INTO watcher_state (session_id, overview_path, last_byte_offset)
           VALUES (?, ?, ?)`
        )
        .run(sessionId, overviewPath, stat.size);

      // Ensure session exists
      this.db.ensureSession(sessionId);
      return;
    }

    // Read new bytes only
    const stat = fs.statSync(overviewPath);
    if (stat.size <= state.last_byte_offset) return; // No new data

    const fd = fs.openSync(overviewPath, "r");
    const newBytes = stat.size - state.last_byte_offset;
    const buffer = Buffer.alloc(newBytes);
    fs.readSync(fd, buffer, 0, newBytes, state.last_byte_offset);
    fs.closeSync(fd);

    const newContent = buffer.toString("utf-8");
    const lines = newContent.split("\n").filter(Boolean);

    let ingested = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line.trim()) as OverviewEntry;

        // Skip already-processed step indices
        if (entry.step_index <= state.last_step_index) continue;

        // Process based on type
        const stored = this.ingestEntry(sessionId, entry);
        if (stored) ingested++;

        // Update last step index
        state.last_step_index = Math.max(state.last_step_index, entry.step_index);
      } catch {
        // Skip unparseable lines
      }
    }

    // Update watcher state
    this.db.db
      .prepare(
        `UPDATE watcher_state 
         SET last_byte_offset = ?, last_step_index = ?, 
             entries_ingested = entries_ingested + ?, last_processed = datetime('now')
         WHERE session_id = ?`
      )
      .run(stat.size, state.last_step_index, ingested, sessionId);

    if (ingested > 0) {
      this.db.logOperation("auto_ingest", "success", `${ingested} entries from ${sessionId.slice(0, 8)}`, 0);
    }
  }

  /**
   * Ingest a single overview entry as a memory
   */
  private ingestEntry(sessionId: string, entry: OverviewEntry): boolean {
    // ── USER_INPUT: High-value — captures what the user wants ──
    if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") {
      return this.ingestUserInput(sessionId, entry);
    }

    // ── PLANNER_RESPONSE with tool_calls: Capture tool usage ──
    if (entry.type === "PLANNER_RESPONSE" && entry.tool_calls?.length) {
      return this.ingestToolCalls(sessionId, entry);
    }

    return false;
  }

  /**
   * Store a user input as a memory
   */
  private ingestUserInput(sessionId: string, entry: OverviewEntry): boolean {
    const content = entry.content || "";

    // Extract actual user request from XML wrapper
    const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    const userMessage = match ? match[1].trim() : "";

    // Skip empty or too-short messages
    if (!userMessage || userMessage.length < 10) return false;

    // Skip if it's just "continue" or single-word commands
    if (/^(continue|lanjut|ok|oke|gas|next|go|yes|ya|y|!+)$/i.test(userMessage.trim())) return false;

    // Truncate very long messages
    const truncated = userMessage.length > 500
      ? userMessage.substring(0, 500) + "..."
      : userMessage;

    try {
      this.db.ensureSession(sessionId);
      this.db.db
        .prepare(
          `INSERT INTO memories (session_id, content, tags, category, priority, trigger_type, source_step_index)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          `[User Request] ${truncated}`,
          '["auto-ingest", "user-request"]',
          "instruction",
          4,
          "AUTO_INGEST",
          entry.step_index
        );

      this.db.db
        .prepare("UPDATE sessions SET total_memories = total_memories + 1, last_active = datetime('now') WHERE id = ?")
        .run(sessionId);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store tool calls as memories with details
   */
  private ingestToolCalls(sessionId: string, entry: OverviewEntry): boolean {
    if (!entry.tool_calls?.length) return false;

    // Filter out noise tools (thinking, search are low-signal for memory)
    const significantTools = entry.tool_calls.filter(tc => {
      const name = tc.name || "";
      // Skip pure thinking/search tools — they're process, not outcome
      if (name.includes("rex_think") || name.includes("sequentialthinking")) return false;
      // Skip hippocampus calls (avoid infinite loop!)
      if (name.includes("hippocampus")) return false;
      return true;
    });

    if (!significantTools.length) return false;

    // Build a summary of tools used
    const toolNames = significantTools.map(tc => tc.name).join(", ");
    const summary = `[Tools Used] ${toolNames}`;

    try {
      this.db.ensureSession(sessionId);
      const result = this.db.db
        .prepare(
          `INSERT INTO memories (session_id, content, tags, category, priority, trigger_type, source_step_index)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          summary,
          '["auto-ingest", "tool-usage"]',
          "code",
          2,
          "AUTO_INGEST",
          entry.step_index
        );

      const memoryId = Number(result.lastInsertRowid);

      // Store individual tool details
      const detailStmt = this.db.db.prepare(
        `INSERT INTO memory_details (memory_id, detail_type, name, value, context, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      for (const tc of significantTools) {
        // Extract key args (skip huge content like file contents)
        const keyArgs: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(tc.args || {})) {
          const strVal = String(v);
          if (strVal.length < 200) {
            keyArgs[k] = v;
          }
        }

        detailStmt.run(
          memoryId,
          "command",
          tc.name,
          JSON.stringify(keyArgs).substring(0, 500),
          `Step ${entry.step_index}`,
          "{}"
        );
      }

      this.db.db
        .prepare("UPDATE sessions SET total_memories = total_memories + 1, last_active = datetime('now') WHERE id = ?")
        .run(sessionId);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get watcher statistics
   */
  getStats(): { active: boolean; sessions_watched: number; total_ingested: number } {
    const row = this.db.db
      .prepare("SELECT COUNT(*) as c, COALESCE(SUM(entries_ingested), 0) as total FROM watcher_state")
      .get() as { c: number; total: number };

    return {
      active: this.intervalId !== null,
      sessions_watched: row.c,
      total_ingested: row.total,
    };
  }
}
