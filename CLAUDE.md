# Cincinnatus — rules for Claude Code

Read docs/SPEC.md before non-trivial work. Constraints that override everything:

1. NO scraping, no headless browsers, no HTML parsing of job sites. JSON APIs from SPEC §6 only.
2. NO auto-apply, no automation of applications.
3. PII stays local. Only egress: search terms to job APIs; Anthropic calls iff user key present. No telemetry.
4. NO fabrication in generated documents — verify.ts entity check is mandatory in the tailor/cover-letter path.
5. Audience has low tech literacy: all UI/chat copy ≤ 6th-grade reading level, zero required config, plain words.
6. Job search works with zero paid keys; AI features gate on the user's Anthropic key, gracefully.
7. Complexity budget: no agent frameworks, MCP, vector DBs, ORMs, Docker. src/core stays free of Tauri/DOM imports.

Workflow: vitest + fixtures (no live network in tests) · conventional commits · append decisions to
docs/DECISIONS.md · verify third-party endpoints against official docs and log corrections · prompts live
in versioned files, not inline strings · when SPEC and reality conflict, stop and ask.

Commands: pnpm dev · pnpm test · pnpm harness … · pnpm tauri build
