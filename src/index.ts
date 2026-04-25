#!/usr/bin/env node

/**
 * 🧠 Hippocampus Memory AI — MCP Server
 * 
 * Persistent Session Memory for AI assistants.
 * Converts short-term context window into long-term searchable memory.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { HippocampusDB } from "./database.js";
import { FallbackWriter } from "./safeguards/fallback.js";
import { remember } from "./tools/remember.js";
import { recall } from "./tools/recall.js";
import { batchRemember } from "./tools/batch-remember.js";
import { checkpoint } from "./tools/checkpoint.js";
import { timeline } from "./tools/timeline.js";
import { getContext, linkSessions } from "./tools/context.js";
import { discoverSessions, renameSession } from "./tools/discover.js";
import { forget } from "./tools/forget.js";
import { AutoIngestWatcher } from "./watcher/auto-ingest.js";

const SERVER_NAME = "hippocampus-memory-ai";
const SERVER_VERSION = "1.1.0";

// ═══════════════════════════════════════
// Environment Configuration
// ═══════════════════════════════════════

const DB_PATH = process.env.DB_PATH || "./hippocampus.db";
const BRAIN_PATH = process.env.BRAIN_PATH || "";
const CURRENT_SESSION = process.env.CURRENT_SESSION_ID || "default";

async function main(): Promise<void> {
  // Initialize database
  const db = new HippocampusDB(DB_PATH);
  const fallback = new FallbackWriter(DB_PATH);

  // Startup health check
  const health = db.healthCheck();
  console.error(`🧠 ${SERVER_NAME} v${SERVER_VERSION}`);
  console.error(`   DB: ${DB_PATH} (${health.status})`);
  console.error(`   Brain: ${BRAIN_PATH || "NOT SET"}`);
  console.error(`   Session: ${CURRENT_SESSION}`);

  // Import any pending fallback entries
  if (fallback.hasPending()) {
    const pending = fallback.readPending();
    console.error(`   ⚠️ Importing ${pending.length} pending fallback entries...`);
    let imported = 0;
    for (const entry of pending) {
      try {
        if (entry.op === "remember" && entry.data) {
          remember(db, fallback, entry.data as any, CURRENT_SESSION);
          imported++;
        }
      } catch {
        // skip failed imports
      }
    }
    if (imported > 0) {
      fallback.clear();
      console.error(`   ✅ Imported ${imported}/${pending.length} entries`);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ═══════════════════════════════════════
  // TOOL: hippocampus_remember
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_remember",
    "Store a memory with optional structured detail atoms (files, functions, configs, etc). Transaction-safe with auto-retry and fallback. IMPORTANT: Always pass your Conversation ID (from user_information metadata) as session_id for proper per-session memory binding.",
    {
      content: z.string().describe("The memory content to store"),
      session_id: z.string().optional().describe("Session/conversation ID — ALWAYS pass your Conversation ID from user_information metadata"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      category: z
        .enum(["decision", "finding", "instruction", "code", "error", "architecture", "general"])
        .optional()
        .describe("Memory category"),
      priority: z.number().min(1).max(5).optional().describe("Priority level 1-5 (default: 3)"),
      trigger_type: z.string().optional().describe("What triggered saving this memory"),
      details: z
        .array(
          z.object({
            type: z.enum(["file", "function", "dependency", "config", "command", "value", "error", "endpoint", "schema", "reference"]),
            name: z.string().optional(),
            value: z.string().optional(),
            context: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          })
        )
        .optional()
        .describe("Structured detail atoms"),
      skip_dedup: z.boolean().optional().describe("Skip deduplication check"),
    },
    async (params) => {
      try {
        const result = remember(db, fallback, params, CURRENT_SESSION);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_recall
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_recall",
    "Search memories by topic using full-text search. Returns memories with detail atoms attached. Searches across sessions if no session_id specified.",
    {
      query: z.string().describe("Search query"),
      session_id: z.string().optional().describe("Limit to specific session"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      category: z.string().optional().describe("Filter by category"),
      limit: z.number().optional().describe("Max results (default: 10, max: 50)"),
      min_priority: z.number().optional().describe("Minimum priority filter"),
      include_details: z.boolean().optional().describe("Include detail atoms (default: true)"),
    },
    async (params) => {
      try {
        const result = recall(db, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_batch_remember
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_batch_remember",
    "Store multiple memories in a single call. Each memory is individually transaction-safe. Max 50 per batch. Always pass session_id (your Conversation ID) for proper session binding.",
    {
      memories: z
        .array(
          z.object({
            content: z.string(),
            tags: z.array(z.string()).optional(),
            category: z.enum(["decision", "finding", "instruction", "code", "error", "architecture", "general"]).optional(),
            priority: z.number().min(1).max(5).optional(),
            trigger_type: z.string().optional(),
            details: z
              .array(
                z.object({
                  type: z.enum(["file", "function", "dependency", "config", "command", "value", "error", "endpoint", "schema", "reference"]),
                  name: z.string().optional(),
                  value: z.string().optional(),
                  context: z.string().optional(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            skip_dedup: z.boolean().optional(),
          })
        )
        .describe("Array of memories to store"),
      session_id: z.string().optional().describe("Session ID for all memories"),
    },
    async (params) => {
      try {
        const result = batchRemember(db, fallback, params, CURRENT_SESSION);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_checkpoint
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_checkpoint",
    "Save a progress checkpoint — like a save-game. Captures topics covered, decisions made, and open questions. Always pass your Conversation ID as session_id.",
    {
      summary: z.string().describe("Checkpoint summary"),
      session_id: z.string().optional().describe("Session ID (defaults to current)"),
      topics_covered: z.array(z.string()).optional().describe("Topics covered so far"),
      decisions_made: z.array(z.string()).optional().describe("Key decisions"),
      open_questions: z.array(z.string()).optional().describe("Unresolved questions"),
    },
    async (params) => {
      try {
        const input = { ...params, session_id: params.session_id || CURRENT_SESSION };
        const result = checkpoint(db, input, CURRENT_SESSION);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_timeline
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_timeline",
    "Get chronological timeline of memories and checkpoints for a session.",
    {
      session_id: z.string().optional().describe("Session ID (defaults to current)"),
      from_time: z.string().optional().describe("Start time filter (ISO)"),
      to_time: z.string().optional().describe("End time filter (ISO)"),
      categories: z.array(z.string()).optional().describe("Filter by categories"),
      limit: z.number().optional().describe("Max entries (default: 100)"),
    },
    async (params) => {
      try {
        const input = { ...params, session_id: params.session_id || CURRENT_SESSION };
        const result = timeline(db, input, CURRENT_SESSION);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_get_context
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_get_context",
    "Search for a topic across ALL sessions. Returns grouped results by session with checkpoints. Use this for cross-session intelligence.",
    {
      topic: z.string().describe("Topic to search for across sessions"),
      max_sessions: z.number().optional().describe("Max sessions to return (default: 5)"),
      include_checkpoints: z.boolean().optional().describe("Include checkpoints (default: true)"),
      min_priority: z.number().optional().describe("Minimum priority filter"),
    },
    async (params) => {
      try {
        const result = getContext(db, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_link_sessions
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_link_sessions",
    "Create a cross-reference link between two sessions.",
    {
      from_session: z.string().describe("Source session ID"),
      to_session: z.string().describe("Target session ID"),
      relationship: z.enum(["continues", "references", "related"]).describe("Relationship type"),
      context: z.string().optional().describe("Why these sessions are linked"),
    },
    async (params) => {
      try {
        const result = linkSessions(db, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_discover_sessions
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_discover_sessions",
    "Scan Antigravity brain/ directory and index all sessions. Auto-extracts titles from conversation history.",
    {
      rescan: z.boolean().optional().describe("Re-scan already indexed sessions"),
      brain_path: z.string().optional().describe("Override brain path"),
    },
    async (params) => {
      try {
        const result = discoverSessions(db, params, BRAIN_PATH);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_rename_session
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_rename_session",
    "Override auto-generated session title with a custom name.",
    {
      session_id: z.string().describe("Session ID to rename"),
      title: z.string().describe("New title for the session"),
    },
    async (params) => {
      try {
        const result = renameSession(db, params.session_id, params.title);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_forget
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_forget",
    "Deactivate or permanently delete a memory.",
    {
      memory_id: z.number().describe("ID of memory to forget"),
      permanent: z.boolean().optional().describe("Hard delete (default: soft deactivate)"),
    },
    async (params) => {
      try {
        const result = forget(db, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_rebuild_index
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_rebuild_index",
    "Rebuild FTS5 full-text search index. Use if search results seem stale.",
    {},
    async () => {
      try {
        const result = db.rebuildFTSIndex();
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "success", ...result }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // TOOL: hippocampus_health
  // ═══════════════════════════════════════

  server.tool(
    "hippocampus_health",
    "Get database health status and statistics. Includes auto-ingest watcher status.",
    {},
    async () => {
      try {
        const healthReport = db.healthCheck();
        const stats = db.getStats();
        const watcherStats = watcher?.getStats() ?? { active: false, sessions_watched: 0, total_ingested: 0 };
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ health: healthReport, stats, auto_ingest: watcherStats }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
      }
    }
  );

  // ═══════════════════════════════════════
  // RESOURCES
  // ═══════════════════════════════════════

  server.resource("memory://stats", "memory://stats", async () => {
    const stats = db.getStats();
    return { contents: [{ uri: "memory://stats", mimeType: "application/json", text: JSON.stringify(stats, null, 2) }] };
  });

  server.resource("memory://health", "memory://health", async () => {
    const healthReport = db.healthCheck();
    return { contents: [{ uri: "memory://health", mimeType: "application/json", text: JSON.stringify(healthReport, null, 2) }] };
  });

  server.resource("memory://sessions", "memory://sessions", async () => {
    const sessions = db.db.prepare("SELECT * FROM sessions ORDER BY last_active DESC").all();
    return { contents: [{ uri: "memory://sessions", mimeType: "application/json", text: JSON.stringify(sessions, null, 2) }] };
  });

  // ═══════════════════════════════════════
  // Connect + Start
  // ═══════════════════════════════════════

  // ═══════════════════════════════════════
  // Auto-Ingest Watcher
  // ═══════════════════════════════════════

  let watcher: AutoIngestWatcher | null = null;
  if (BRAIN_PATH) {
    watcher = new AutoIngestWatcher(db, BRAIN_PATH, 10_000);
    watcher.start();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`🧠 ${SERVER_NAME} — Ready. ${db.getStats().memories} memories loaded. Watcher: ${watcher ? 'ON' : 'OFF'}`);

  // Graceful shutdown
  const shutdown = () => {
    watcher?.stop();
    db.createBackup();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error starting hippocampus:", error);
  process.exit(1);
});
