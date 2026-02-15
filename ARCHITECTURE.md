# Architecture

This document describes the runtime architecture of the local memory MCP server.

## Overview

The service is a local MCP server that:

1. receives tool calls over stdio,
2. generates embeddings via Ollama (`embeddinggemma`),
3. stores and retrieves vectors + metadata using Zvec,
4. returns structured tool responses to the MCP client.

## High-level Flow

```text
MCP Client (VS Code / Claude)
  -> memory.search | memory.save | memory.supersede | memory.delete
  -> src/index.ts (tool handlers + validation)
  -> src/embed.ts (Ollama /api/embed)
  -> src/db.ts (Zvec collection operations)
  -> response payload to MCP client
```

## Main Components

### 1) MCP API Layer (`src/index.ts`)

Responsibilities:

- registers MCP tools:
  - `memory.ping`
  - `memory.search`
  - `memory.save`
  - `memory.supersede`
  - `memory.delete`
- validates input schemas with Zod,
- resolves `workspaceKey` defaults,
- orchestrates embedding + storage/query calls,
- formats output for MCP content blocks.

### 2) Embedding Layer (`src/embed.ts`)

Responsibilities:

- calls Ollama `POST /api/embed`,
- uses env-configurable base URL and model:
  - `OLLAMA_BASE_URL`
  - `OLLAMA_EMBED_MODEL`
- maps JSON embeddings to `Float32Array[]`,
- surfaces explicit runtime errors for non-2xx/invalid responses.

Why separate this layer:

- keeps provider-specific logic isolated,
- makes future provider swaps easier,
- simplifies testing with `fetch` mocking.

### 3) Persistence + Search Layer (`src/db.ts`)

Responsibilities:

- opens/creates a Zvec collection at `MEMORY_DB_PATH`,
- defines schema for vector + scalar metadata fields,
- implements CRUD-style memory operations:
  - `saveMemory`
  - `searchMemory`
  - `supersedeMemory`
  - `deleteMemory`
- enforces embedding dimension consistency (`EMBEDDING_DIM`),
- applies workspace/type/superseded filters,
- updates `lastUsedAt` on retrieval.

## Data Model

### Vector Field

- `embedding` (`VECTOR_FP32`, dimension = `EMBEDDING_DIM`, default `768`)

### Scalar Metadata Fields

- `id`
- `workspaceKey`
- `type`
- `text`
- `summary`
- `tagsJson`
- `importance`
- `createdAt`
- `lastUsedAt`
- `supersededBy`

## Tool Operation Mapping

- `memory.save`
  - embed `text` via Ollama
  - insert vector + metadata into Zvec

- `memory.search`
  - embed `query` via Ollama
  - vector query with metadata filters
  - optional type scoping
  - suppress superseded entries

- `memory.supersede`
  - mark an older memory with `supersededBy`

- `memory.delete`
  - delete by id (optionally workspace-validated)

- `memory.ping`
  - returns health metadata (`engine`, `store`, `dim`)

## Runtime Configuration

Environment variables:

- `MEMORY_DB_PATH` (default `./data/memory.zvec`)
- `OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `OLLAMA_EMBED_MODEL` (default `embeddinggemma`)
- `EMBEDDING_DIM` (default `768`)
- `WORKSPACE_KEY` (default `default`)

## Error Handling Strategy

- input validation at MCP boundary via Zod,
- embedding call failures propagated with detailed HTTP context,
- Zvec status objects checked and converted to thrown errors,
- best-effort metadata updates (e.g., `lastUsedAt`) do not fail primary reads.

## Testing Strategy

Current tests cover:

- embedding client behavior and error handling (`tests/embed.test.ts`),
- persistence/query lifecycle (`save/search/supersede/delete`) in Zvec (`tests/memory-db.test.ts`).

Run all tests:

```bash
bun run test
```

## Extension Points

- swap embedding provider by replacing internals of `src/embed.ts`,
- add ranking/re-ranking in `searchMemory`,
- add additional metadata fields via Zvec schema evolution,
- add index tuning calls (`createIndexSync`, `optimizeSync`) for larger datasets.
