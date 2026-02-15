# Local Memory MCP Server for Coding Agents

This project is a **local MCP (Model Context Protocol) server** that exposes a small set of tools:

- `memory.search` – semantic search over stored memories
- `memory.save` – store a new memory
- `memory.supersede` – mark an old memory as superseded
- `memory.delete` – permanently remove a memory by id
- `memory.ping` – sanity check / version output

## What you can do with this project

- Keep durable coding context across chat sessions (decisions, preferences, gotchas, API contracts).
- Retrieve relevant past context semantically (not only keyword matching).
- Scope memory per project using `WORKSPACE_KEY` while keeping one shared local database.
- Correct memory over time by superseding outdated entries or deleting irrelevant ones.
- Run everything locally (no external vector DB required).

### Typical workflow

1. User asks a question in chat.
2. Agent calls `memory.search` to fetch relevant context.
3. Agent answers using retrieved memory + current codebase context.
4. New durable insight is stored via `memory.save`.
5. Old memory is updated via `memory.supersede` or removed via `memory.delete`.


It uses:

- **Bun** + **TypeScript**
- **bun:sqlite** for a local SQLite DB (fast, embedded) (docs: https://bun.com/docs/runtime/sqlite)
- **sqlite-vec** to do KNN vector search via a `vec0` virtual table (docs + Bun recipe: https://alexgarcia.xyz/sqlite-vec/js.html, vec0 docs: https://alexgarcia.xyz/sqlite-vec/features/vec0.html)
- **Ollama** `/api/embed` with `embeddinggemma` for embeddings (docs: https://docs.ollama.com/capabilities/embeddings, model page: https://ollama.com/library/embeddinggemma)

## Prerequisites

- Bun installed
- Ollama installed and running locally

Pull the embedding model:

```bash
ollama pull embeddinggemma
```

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

This runs an MCP server over **stdio**.

### Environment variables

- `OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `OLLAMA_EMBED_MODEL` (default `embeddinggemma`)
- `MEMORY_DB_PATH` (default `./data/memory.db`)
- `WORKSPACE_KEY` (default `default`)

### macOS note (SQLite extensions)

On macOS, Bun may use Apple's SQLite build, which can disable extension loading. If `sqlite-vec` fails to load, set:

- `CUSTOM_SQLITE_PATH=/path/to/libsqlite3.dylib`

## VS Code

### Workspace setup

This repo includes `.vscode/mcp.json` that registers this server:

- command: `bun`
- args: `run start`

You can adjust environment variables in that file.

### Always-on across all projects

If you want this MCP server available in all workspaces, add it to your **User MCP configuration** instead of only `.vscode/mcp.json`:

1. Open Command Palette: `MCP: Open User Configuration`
2. Add a server entry that starts this repo from a fixed directory.

Example (Linux):

```json
{
  "servers": {
    "local-memory-mcp": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "--cwd",
        "/path/to/local-memory-mcp",
        "run",
        "start"
      ],
      "env": {
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_EMBED_MODEL": "embeddinggemma",
        "MEMORY_DB_PATH": "/path/to/local-memory-mcp/data/memory.db",
        "WORKSPACE_KEY": "${workspaceFolderBasename}"
      }
    }
  }
}
```

Notes:

- Use an **absolute** `MEMORY_DB_PATH` so all projects use the same database.
- `WORKSPACE_KEY=${workspaceFolderBasename}` keeps memories separated per project automatically.
- Enable VS Code setting `chat.mcp.autoStart` (Experimental) to auto-start/restart MCP servers when needed.

Docs:

- https://code.visualstudio.com/docs/copilot/customization/mcp-servers

## Claude Code

Add this server to Claude Code as a local stdio MCP server.

This repository already includes:

- `.mcp.json` for project-scoped Claude MCP configuration
- `CLAUDE.md` for memory-first agent behavior guidelines

### User scope (all projects)

```bash
claude mcp add --transport stdio --scope user \
  --env OLLAMA_BASE_URL=http://localhost:11434 \
  --env OLLAMA_EMBED_MODEL=embeddinggemma \
  --env MEMORY_DB_PATH=/absolute/path/to/local-memory-mcp/data/memory.db \
  --env WORKSPACE_KEY=default \
  local-memory-mcp -- bun --cwd /absolute/path/to/local-memory-mcp run start
```

### Project scope (shared in repository)

```bash
claude mcp add --transport stdio --scope project \
  --env OLLAMA_BASE_URL=http://localhost:11434 \
  --env OLLAMA_EMBED_MODEL=embeddinggemma \
  --env MEMORY_DB_PATH=./data/memory.db \
  --env WORKSPACE_KEY=${PWD##*/} \
  local-memory-mcp -- bun run start
```

Project `.mcp.json` example:

```json
{
  "mcpServers": {
    "local-memory-mcp": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "start"],
      "env": {
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_EMBED_MODEL": "embeddinggemma",
        "MEMORY_DB_PATH": "./data/memory.db",
        "WORKSPACE_KEY": "${PWD##*/}"
      }
    }
  }
}
```

Notes:

- `--scope project` writes to `.mcp.json` in the project root.
- `--scope user` stores the server in your user Claude configuration.
- Keep all Claude flags before the server name, and put `--` before the server command.

Useful commands:

```bash
claude mcp list
claude mcp get local-memory-mcp
claude mcp remove local-memory-mcp
```

Docs:

- https://code.claude.com/docs/en/mcp

## Tool usage (examples)

### Search

```json
{
  "tool": "memory.search",
  "arguments": {
    "query": "What is our policy for multi-session memory?",
    "topK": 8,
    "workspaceKey": "my-repo"
  }
}
```

### Save

```json
{
  "tool": "memory.save",
  "arguments": {
    "workspaceKey": "my-repo",
    "type": "decision",
    "summary": "We use embeddinggemma via local Ollama + sqlite-vec vec0 for long-term memory.",
    "text": "Decision: The Copilot/agent memory sidecar uses Ollama /api/embed with embeddinggemma and stores vectors in sqlite-vec (vec0).",
    "tags": ["memory", "ollama", "sqlite-vec"],
    "importance": 0.8
  }
}
```

### Delete

```json
{
  "tool": "memory.delete",
  "arguments": {
    "workspaceKey": "my-repo",
    "id": 42
  }
}
```
