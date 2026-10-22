# Generic core implementation ledger

Approved plan: user-provided Generic Core Code Changes, 2026-10-21.

Tasks:
1. Required chat session context, Semantic isolation, merged prepare model call, session-bound tools.
2. Shared versioned batch review contracts and validation, Semantic graph batch execution.
3. Persisted Procedural batch preview/approval with one-text compatibility.
4. API integration, regression coverage, README/cURL updates and final review.

Baseline: 53 tests and typecheck passed during planning.
Ruling: work in the existing langgraph-with-memories feature branch because the approved work extends current uncommitted implementation. Preserve unrelated staged/unstaged files; no commits requested.
Ruling: review decisions use create/update/skip/edit/preference; approve/deny/decline aliases are accepted for Procedural clients. An edit or preference choice produces another exact-text review before any write.
Ruling: Procedural proposals persist in an unindexed organization-scoped PostgresStore namespace. No business schema changes or automatic legacy Semantic migration.

Task 1: complete - required chat session schema, session-scoped Semantic namespaces, combined prepare call, compact tool selection, source session metadata and session-bound frozen proposals. Core tests observed RED then GREEN.
Task 2: complete - stable batch/item IDs, combined scope/search/review, whole-submission validation, retained approvals on edits, exact preference review, per-ID outcomes, stale-target preflight and safe final-approval replay. Batch/graph tests observed RED then GREEN.
Task 3: complete - persisted organization-scoped Procedural previews, partial decisions/edits, per-item progress, restart/retry behavior and legacy one-text adapter. HTTP tests observed RED then GREEN.
Task 4: complete - API contracts integrated, README/cURL examples and deployment notes updated. Final review performed directly against source and tests; existing feature-branch changes preserved.

Ruling: partial decision changes invalidate the reviewId to prevent stale clients replacing retained approvals; final approvals retain their token for retries.
Ruling: an interrupted approved Semantic execution can only resume the checkpointed choices, never replace them with new decisions.
Final verification: pnpm test -> 87/87 passed across 10 files; pnpm typecheck -> passed; git diff --check -> passed. HTTP tests ran with approved loopback access. No live Bedrock or PostgreSQL integration was run.
