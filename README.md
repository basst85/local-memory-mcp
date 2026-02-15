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
- **Zvec** (`@zvec/zvec`) as embedded in-process vector database (docs: https://zvec.org/en/docs/)
- **Ollama** `/api/embed` with **embeddinggemma** for embeddings (docs: https://docs.ollama.com/capabilities/embeddings, model: https://ollama.com/library/embeddinggemma)

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

## Test

```bash
bun run test
```

Current tests include:

- `tests/embed.test.ts` – validates Ollama embedding response parsing and error handling
- `tests/memory-db.test.ts` – validates `save`, `search`, `supersede`, and `delete` on the Zvec-backed store

### Environment variables

- `MEMORY_DB_PATH` (default `./data/memory.zvec`)
- `OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `OLLAMA_EMBED_MODEL` (default `embeddinggemma`)
- `EMBEDDING_DIM` (default `768`, must match your embedding model)
- `WORKSPACE_KEY` (default `default`)

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
      "args": ["--cwd", "/path/to/local-memory-mcp", "run", "start"],
      "env": {
        "MEMORY_DB_PATH": "/path/to/local-memory-mcp/data/memory.zvec",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_EMBED_MODEL": "embeddinggemma",
        "EMBEDDING_DIM": "768",
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
  --env MEMORY_DB_PATH=/absolute/path/to/local-memory-mcp/data/memory.zvec \
  --env OLLAMA_BASE_URL=http://localhost:11434 \
  --env OLLAMA_EMBED_MODEL=embeddinggemma \
  --env EMBEDDING_DIM=768 \
  --env WORKSPACE_KEY=default \
  local-memory-mcp -- bun --cwd /absolute/path/to/local-memory-mcp run start
```

### Project scope (shared in repository)

```bash
claude mcp add --transport stdio --scope project \
  --env MEMORY_DB_PATH=./data/memory.zvec \
  --env OLLAMA_BASE_URL=http://localhost:11434 \
  --env OLLAMA_EMBED_MODEL=embeddinggemma \
  --env EMBEDDING_DIM=768 \
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
        "MEMORY_DB_PATH": "./data/memory.zvec",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_EMBED_MODEL": "embeddinggemma",
        "EMBEDDING_DIM": "768",
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
    "summary": "We use zvec with Ollama embeddinggemma for long-term memory.",
    "text": "Decision: The Copilot/agent memory sidecar stores vectors in zvec and generates embeddings via Ollama /api/embed using embeddinggemma.",
    "tags": ["memory", "zvec", "ollama", "embeddinggemma"],
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

## Implementation notes

- The DB uses one Zvec collection with:
  - dense vector field `embedding`
  - scalar fields for metadata (`workspaceKey`, `type`, `summary`, etc.)
- KNN queries are executed through Zvec `querySync` with metadata filters.

## Tests

Run all tests:

```bash
bun run test
```

Current test coverage:

- `tests/embed.test.ts`
  - parses successful Ollama `/api/embed` responses into `Float32Array`
  - verifies error handling when Ollama returns non-2xx responses
- `tests/memory-db.test.ts`
  - validates `save` + `search` behavior with workspace/type filtering
  - validates `supersede` behavior (superseded items are excluded from search)
  - validates `delete` behavior and returned payload semantics
