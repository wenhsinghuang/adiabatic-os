# Retrieval Memory Module Requirements

Status: requirement draft

This document captures the requirement for retrieval and memory support without choosing a specific implementation, schema, embedding provider, vector database, or memory framework.

## Core Requirement

Adiabatic needs a retrieval/memory layer that can make D0, D1, and D2 data findable by semantic intent without changing what the core data means.

The module exists to provide a replaceable retrieval data source over the substrate.

```text
D0 events / D1 docs / D2 rows
  -> retrieval/memory module
  -> searchable/retrievable context
  -> references back to raw substrate objects
```

The retrieval layer must not become source of truth.

## Positioning

This should not be framed as an embedding module.

Embedding is one possible implementation detail. The durable requirement is retrieval and context access.

The module should be able to support, now or later:

- full-text search
- dense vector search
- sparse vector search
- hybrid retrieval
- reranking
- summary indexes
- fact memories
- memory blocks
- archival memory
- temporal/entity graph memory
- external memory frameworks
- future multimodal retrieval

The system should be able to swap techniques without changing D0/D1/D2.

## Truth Boundary

D0/D1/D2 are the substrate.

Retrieval and memory outputs are derived, rebuildable, and versioned.

```text
truth:
  D0 event
  D1 doc
  D2 row

derived:
  chunk
  embedding
  summary
  fact
  relation
  graph edge
  retrieval score
  assembled context
```

Derived retrieval artifacts must reference the raw object they came from.

## Why This Exists

Search is only one use case. The broader need is controlled context assembly.

Potential consumers:

- user semantic search
- LLM question answering
- agent context retrieval
- optimizer analysis
- duplicate/similarity detection
- pattern discovery
- memory consolidation
- future graph-based reasoning

The end product is not a vector result. The useful output is relevant context with provenance.

## Replacement Requirement

The module must be provider-agnostic.

Core should not depend directly on:

- one embedding model
- one vector DB
- one chunking strategy
- one memory framework
- one ranking strategy
- one summary/fact extraction policy

Any provider or memory policy must be replaceable because retrieval technology changes quickly.

Examples of replaceable implementations:

```text
SQLite FTS
sqlite-vec
pgvector
LanceDB
external memory API
graph memory provider
hybrid search provider
local-only provider
cloud provider
```

## Versioning Requirement

Every derived retrieval artifact must be attributable to the policy that produced it.

The module should track enough version information to decide whether an artifact is stale and can be rebuilt.

Likely version axes:

- source target version or input hash
- formatter version
- redaction policy version
- chunking policy version
- model/provider version
- memory policy version

The exact schema is not decided here.

## Privacy Requirement

Retrieval can amplify privacy risk because it makes raw data easier to find and assemble.

The module must respect substrate privacy decisions:

- locked docs
- local-only tables
- connector redaction policies
- future forget/delete policies
- cloud sync boundaries

Retrieval indexing should happen after redaction policy is applied. It must be possible to rebuild indexes when privacy policy changes.

## Connector Boundary

Connectors should not call embedding models or own retrieval indexes.

Connectors write raw D0 events. Retrieval/memory indexing is system work.

```text
connector
  -> guard.writeEvent(...)
  -> D0
  -> retrieval/memory module indexes later
```

This keeps ingestion dumb and keeps model cost, redaction, retry, and provider choice centralized.

## App Boundary

Apps may query retrieval results, but apps should not become the owner of retrieval infrastructure.

An app can ask:

```text
find relevant events/docs/rows for this query
```

The app should receive references and context, not raw provider internals.

## Non-Goals

This document does not decide:

- storage schema
- vector representation
- embedding provider
- chunking strategy
- query API
- ranking algorithm
- memory consolidation policy
- whether to store facts, summaries, or graph edges
- whether retrieval runs locally or in cloud

Those decisions should be made when the first retrieval use case is implemented.

## Design Bias

The safest starting bias:

```text
retrieval module = rebuildable semantic access layer
```

Not:

```text
retrieval module = permanent memory database
```

The module should make the substrate easier to retrieve from while preserving the substrate as the durable source of truth.
