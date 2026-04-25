#!/usr/bin/env node

/**
 * 🧠 Hippocampus Memory AI — MCP Server
 * 
 * Persistent Session Memory for AI assistants.
 * Converts short-term context window into long-term searchable memory.
 * 
 * Features:
 * - Structured memory with detail atoms (files, functions, configs, etc)
 * - Full-text search via SQLite FTS5
 * - Cross-session recall
 * - Auto-backup + fallback safety net
 * - Session discovery from Antigravity brain/ directory
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SERVER_NAME = "hippocampus-memory-ai";
const SERVER_VERSION = "1.0.0";

async function main(): Promise<void> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ═══════════════════════════════════════════
  // Tools will be registered here in Phase 3-11
  // ═══════════════════════════════════════════

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup (stderr so it doesn't interfere with MCP protocol on stdout)
  console.error(`🧠 ${SERVER_NAME} v${SERVER_VERSION} — MCP server started`);
}

main().catch((error) => {
  console.error("Fatal error starting hippocampus:", error);
  process.exit(1);
});
