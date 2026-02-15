# Claude project instructions

## Memory-first workflow

1. For each new user request, first call `memory.search` with the user prompt and current workspace context.
2. Use returned memories as constraints for decisions, preferences, and API behavior.
3. Save durable information with `memory.save` (decision, preference, fact, gotcha, todo, api_contract).
4. Use `memory.supersede` when replacing outdated memory with a newer item.
5. Use `memory.delete` for obsolete or irrelevant memory when explicitly requested.

## Memory quality guidelines

- Keep `summary` short and reusable (1–2 lines).
- Save only durable project knowledge, not transient debugging noise.
- Prefer project-specific `WORKSPACE_KEY` values when working across repositories.
