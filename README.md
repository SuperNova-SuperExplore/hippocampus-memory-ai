# 🧠 Hippocampus Memory AI

> **Persistent Session Memory for AI Assistants**
> Converts short-term context windows into long-term, searchable memory using SQLite FTS5.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Server](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)

---

## The Problem

AI assistants forget everything between sessions. They lose context on:
- What files were being edited
- What architecture decisions were made
- What bugs were found and fixed
- What the user's preferences are

**Hippocampus fixes this.** It gives AI assistants a persistent, structured memory layer that survives across sessions and conversations.

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                    AI ASSISTANT (Claude, Gemini, etc.)        │
│                                                              │
│  "Remember this..."   →   hippocampus_remember()             │
│  "What did we do?"    →   hippocampus_recall()               │
│  "Save progress"      →   hippocampus_checkpoint()           │
│  "Search all history" →   hippocampus_get_context()          │
└──────────────┬───────────────────────────────────────────────┘
               │ MCP Protocol (stdio)
               ▼
┌──────────────────────────────────────────────────────────────┐
│              🧠 HIPPOCAMPUS MCP SERVER                       │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────────────────┐      │
│  │  SQLite + WAL    │  │  FTS5 Full-Text Search       │      │
│  │  (atomic writes) │  │  (instant recall by topic)   │      │
│  └─────────────────┘  └──────────────────────────────┘      │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────────────────┐      │
│  │  Detail Atoms    │  │  Auto-Ingest Watcher         │      │
│  │  (file, func,    │  │  (monitors overview.txt →    │      │
│  │   config, cmd)   │  │   auto-stores memories)      │      │
│  └─────────────────┘  └──────────────────────────────┘      │
│                                                              │
│  ┌─────────────────┐                                        │
│  │  Fallback Safety │                                        │
│  │  (JSONL backup)  │                                        │
│  └─────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
```

## Features

- ⚡ **Instant Storage** — <50ms per memory operation via MCP native calls
- 🔍 **Full-Text Search** — FTS5-powered semantic search across all sessions
- 🧬 **Detail Atoms** — Structured metadata (files, functions, configs, commands, errors)
- 📸 **Checkpoints** — Save-game style progress snapshots
- 🌐 **Cross-Session** — Search and link memories across conversation boundaries
- 🛡️ **Zero Data Loss** — Transaction atomicity + JSONL fallback safety net
- 🔄 **Auto-Backup** — Automatic database backups every 100 writes or 24 hours
- 📊 **Health Monitoring** — 7-point health check on every startup
- 🤖 **Auto-Ingest** — Background watcher monitors conversation logs and auto-stores memories without AI involvement

---

## Installation

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# Clone the repository
git clone https://github.com/SuperNova-SuperExplore/hippocampus-memory-ai.git
cd hippocampus-memory-ai

# Install dependencies
npm install

# Build
npm run build
```

### MCP Configuration

Add to your MCP client's configuration (e.g., `mcp_config.json`):

```json
{
  "mcpServers": {
    "hippocampus": {
      "command": "node",
      "args": ["path/to/hippocampus-memory-ai/dist/index.js"],
      "env": {
        "DB_PATH": "path/to/hippocampus.db",
        "BRAIN_PATH": "path/to/brain/directory"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_PATH` | Path to SQLite database file | `./hippocampus.db` |
| `BRAIN_PATH` | Path to AI brain/session directory | (empty) |
| `CURRENT_SESSION_ID` | Active session identifier | `default` |

---

## Tools Reference

### `hippocampus_remember`

Store a memory with optional structured detail atoms.

```json
{
  "content": "Implemented JWT auth with RS256 signing",
  "category": "architecture",
  "priority": 4,
  "tags": ["auth", "jwt", "security"],
  "details": [
    { "type": "file", "name": "auth.ts", "value": "/src/middleware/auth.ts" },
    { "type": "dependency", "name": "jsonwebtoken", "value": "^9.0.0" },
    { "type": "config", "name": "JWT_ALGORITHM", "value": "RS256" }
  ]
}
```

**Categories:** `decision` | `finding` | `instruction` | `code` | `error` | `architecture` | `general`

**Detail Types:** `file` | `function` | `dependency` | `config` | `command` | `value` | `error` | `endpoint` | `schema` | `reference`

### `hippocampus_recall`

Search memories using full-text search with automatic fallback.

```json
{
  "query": "JWT authentication",
  "category": "architecture",
  "min_priority": 3,
  "limit": 10
}
```

Search cascades: FTS5 → LIKE → basic substring match.

### `hippocampus_batch_remember`

Store up to 50 memories in a single call. Each memory is individually transaction-safe.

```json
{
  "memories": [
    { "content": "Memory 1", "priority": 3 },
    { "content": "Memory 2", "tags": ["important"] }
  ]
}
```

### `hippocampus_checkpoint`

Save a progress checkpoint — like a save-game.

```json
{
  "summary": "Completed Phase 1: Auth system",
  "topics_covered": ["JWT", "middleware", "route guards"],
  "decisions_made": ["RS256 over HS256", "Redis session store"],
  "open_questions": ["Rate limiting strategy?"]
}
```

### `hippocampus_timeline`

Get chronological view of memories + checkpoints for a session.

```json
{
  "session_id": "abc-123",
  "categories": ["decision", "architecture"],
  "limit": 50
}
```

### `hippocampus_get_context`

Search across ALL sessions for a topic. Returns grouped results by session.

```json
{
  "topic": "database migration",
  "max_sessions": 5,
  "include_checkpoints": true
}
```

### `hippocampus_link_sessions`

Create cross-references between related sessions.

```json
{
  "from_session": "session-1-uuid",
  "to_session": "session-2-uuid",
  "relationship": "continues",
  "context": "Resumed database migration work"
}
```

### `hippocampus_discover_sessions`

Scan the brain directory and auto-index all sessions with extracted titles.

```json
{
  "rescan": false,
  "brain_path": "/path/to/brain"
}
```

### `hippocampus_rename_session`

Override auto-generated session title.

```json
{
  "session_id": "abc-123",
  "title": "JWT Auth Implementation"
}
```

### `hippocampus_forget`

Soft-delete (deactivate) or permanently delete a memory.

```json
{
  "memory_id": 42,
  "permanent": false
}
```

### `hippocampus_rebuild_index`

Rebuild FTS5 search indexes. Use if search results seem stale.

### `hippocampus_health`

Get database health status with 7-point diagnostic check + auto-ingest watcher status.

---

## Auto-Ingest Watcher

The server includes a **background filesystem watcher** that automatically captures conversation activity — no AI action required.

### How It Works

1. Every 10 seconds, the watcher scans for recently modified `overview.txt` files in the brain directory
2. New JSONL entries are parsed and classified
3. User requests are stored as high-priority `instruction` memories
4. Tool usage is stored as `code` memories with detail atoms
5. Session ID is auto-detected from the directory name (UUID)

### What Gets Auto-Captured

| Entry Type | Stored As | Priority |
|------------|-----------|----------|
| User requests | `instruction` memory | 4 (high) |
| Tool calls | `code` memory + details | 2 |
| Short/error responses | ❌ Skipped | — |
| Hippocampus calls | ❌ Skipped (loop prevention) | — |

### Requirements

- `BRAIN_PATH` environment variable must be set to the AI's brain directory
- The brain directory must contain session subdirectories with `overview.txt` files
- The watcher starts automatically on server boot and stops on shutdown

## Architecture

### Database Schema

```
sessions          1 ←→ N  memories
memories          1 ←→ N  memory_details
sessions          1 ←→ N  checkpoints
sessions (from)   N ←→ N  sessions (to)    via cross_refs
```

### Storage Layers

| Layer | Table | Purpose |
|-------|-------|---------|
| **Summary** | `memories` | High-level semantic content |
| **Detail** | `memory_details` | Atomic technical artifacts |
| **Progress** | `checkpoints` | Session state snapshots |
| **Graph** | `cross_refs` | Inter-session relationships |
| **Index** | `memories_fts`, `details_fts` | Full-text search (FTS5) |
| **Ops** | `ops_log` | Operation tracking |
| **Watcher** | `watcher_state` | Auto-ingest file tracking |

### Safety Guarantees

1. **Atomic Writes** — All operations wrapped in SQLite transactions
2. **WAL Mode** — Write-ahead logging for crash recovery
3. **Retry Logic** — Automatic single retry on transient failures
4. **Fallback File** — JSONL append-only backup when DB is unavailable
5. **Auto-Import** — Pending fallback entries imported on next healthy startup
6. **Auto-Backup** — Database backed up every 100 writes or 24 hours
7. **Deduplication** — Word-overlap similarity check prevents duplicate memories

---

## Resources

The server exposes read-only MCP resources:

| URI | Description |
|-----|-------------|
| `memory://stats` | Global database statistics |
| `memory://health` | Health check results |
| `memory://sessions` | All indexed sessions |

---

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Start
npm start
```

---

## License

[MIT](LICENSE)
