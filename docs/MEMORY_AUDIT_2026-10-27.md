# Memory audit — October 27, 2026

The three memory mechanisms exist, but the complete behavior is not working correctly. The approved live run of `Fetch customers data` retrieved the applicable procedure and past episodes, ignored the procedure's output restriction, skipped a fresh source lookup, and saved the resulting answer as another episode.

## Scope and stored inventory

Inspected every current record in the configured local PostgreSQL memory store and decoded the latest checkpoint for every stored conversation. There was one conversation: organization `ORG-001`, employee `EMP-001`, thread `THREAD-001`.

Before the run:

| Memory | Stored contents |
| --- | --- |
| Procedural | One organization-wide procedure, `record-lookup` |
| Episodic | Four organization-wide episodes, all for `Fetch customers data` |
| Semantic | No facts in the conversation's `semanticMemory` checkpoint |
| Employee preferences | No saved employee-profile records |

The complete procedure was:

> When the user fetch Customers data, only fetch Customer name

All four original episodes returned five sample customers with IDs, names, emails, city fields, and statuses. The first three episodes contained a `get_customer` call with `limit: 5`. The fourth contained only the user message and final assistant answer, with no fresh customer lookup.

## Approved live run

Executed the current source graph with the existing conversation context and configured AWS Bedrock model, after the user explicitly approved transmitting selected memories and fictional sample customer data and saving the resulting history.

| Check | Observed result |
| --- | --- |
| Input | `Fetch customers data` |
| Normalized prompt | `Fetch customer data` |
| Intent | `read` |
| Semantic facts selected or extracted | None |
| Procedure selected | `record-lookup`, with its complete original instructions |
| Episodes selected | Three previous customer-fetch episodes |
| Model calls | Four: normalization, memory selection, interpretation, answer |
| Tools called | None; the graph did not visit the tools node |
| Final answer | Five sample customers, including IDs, emails, cities, and statuses |
| Episode saved | Yes; verified directly in PostgreSQL |
| New episode | `dc20e36b-3c18-4452-b5e6-d9ba7ba8acb5`, containing two messages and no tool trace |
| Existing records preserved | Yes; verified by comparing all original keys and values |

There are now five episodes and the same one procedure. This run did not create semantic facts or employee preferences.

## Assessment by memory type

**Procedural: retrieval passes; application fails.** The memory selector returned the relevant procedure intact. The answer nevertheless displayed fields beyond customer names. The failure occurs after retrieval, so changing search terms alone would not address the observed problem.

**Episodic: persistence and retrieval pass; use of historical answers is unreliable.** Three relevant historical excerpts reached the answer stage, and the new episode was saved correctly. However, the answer claimed that customer data had been retrieved without a tool call in the current turn. The original fourth episode had the same issue. Earlier answers remain available as examples even when they violate the current procedure.

The output closely follows previous answers, which suggests imitation of history. This is an inference: both selected episodes and recent conversation history were supplied, so this single run cannot determine their separate causal effects.

**Semantic: storage mechanics pass isolated checks; live extraction and recall remain unverified.** There were no saved facts to retrieve, and this prompt contains no new fact to remember. Empty `facts` and `memoryMatches` are therefore appropriate. This live run does not establish whether the model correctly extracts, selects, and uses semantic facts for a suitable memory prompt.

General semantic facts currently belong to an organization/thread checkpoint. Only `self.preferred_name` and `self.mention_name_in_replies` are separately persisted by organization/employee and loaded across threads. Other facts and response preferences do not automatically follow an employee into a different thread.

## Verified implementation gaps

1. **Fresh source lookup is requested in instructions but is not enforced by graph control flow.** `src/graph/nodes/llm.ts:42` asks for a lookup. In `src/graph/graph.ts:74`, a model reply without tool calls proceeds directly to response formatting, including for a `read` intent. The observed run took that path.
2. **Procedure compliance is not checked before returning the answer.** Procedures are supplied to the model in `src/graph/nodes/llm.ts:118`. The response formatter in `src/graph/nodes/format-response.ts:19` handles employee name preferences; it does not validate the selected procedure's field restriction.
3. **Episode completion is not equivalent to verified task success.** `src/graph/nodes/memory.ts:62` checks that there is a completed, usable assistant message, then saves it. It does not check whether a required source lookup occurred or whether the answer followed the procedure. The failed live answer was consequently stored as another episode.

Additional limits: only the latest five episodes are retained per organization, and at most three are selected per turn. The selector rejects catalogs above 100 semantic facts, 50 procedures, or 60,000 input characters. These are explicit current capacity limits, not failures encountered in this run.

## Verification and limits

- `npm run check`: passed.
- `npm test`: reported zero tests; it does not provide memory regression coverage.
- Eleven temporary local diagnostic checks passed, covering fact replacement, employee preference isolation and cross-thread loading, semantic checkpoint merging and thread scope, original episode structure, episode organization scope, name formatting, selected-memory forwarding, unknown candidate ID rejection, empty-catalog handling, semantic catalog capacity, and recent-history bounds.
- Those diagnostic checks used isolated in-memory storage and deterministic model-selection responses. They did not test live semantic extraction, live semantic ranking, PostgreSQL semantic persistence across process restarts, or model compliance beyond the one approved prompt.

Recommended next changes are to enforce source lookup for source-backed reads, validate applicable structured output restrictions before returning an answer, and mark episodes with verification/compliance results before making them available for future recall. A separate live save/correct/recall sequence is needed to evaluate semantic memory end to end.

Application source was not changed. The approved run added normal conversation checkpoints and one episode. Diagnostic evidence is saved locally under `/private/tmp/langgraph-memory-audit-20261027/` as `snapshot.json`, `live-fetch.json`, `after-run.json`, and `local-checks.json`.
