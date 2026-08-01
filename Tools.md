# Roblox Super MCP Tools

This document explains every tool added by Roblox Super MCP. It is written as a practical guide: what each tool is for, when to use it, what its important inputs mean, and what safety behavior to expect.

## What this MCP adds

Roblox Super MCP sits in front of the official Roblox Studio MCP. It adds a project-aware engineering layer for discovering systems, understanding relationships, auditing Luau, planning changes, applying safe edits, and verifying or reversing those edits.

The server exposes two kinds of tools:

1. **Super MCP tools** listed below. These are implemented in this repository.
2. **Official Studio MCP tools**, which are forwarded through unchanged when their names do not conflict with a Super MCP tool.

Most analysis tools use the project index. The index is built from live Studio evidence and includes scripts, instances, services, remotes, modules, dependencies, functions, attributes, and related metadata. Use `analyze_project` first when the project may have changed.

Analysis tools do not modify the place. The mutation tools are `apply_script_patch` and `create_architecture`; both require an idempotency key for live changes and return a transaction that can be verified or rolled back.

## Recommended workflow

For a new task, use this order when applicable:

```text
analyze_project
  -> find_system / search_source / get_related_code
  -> read_script_context / inspect_instance
  -> impact_analysis / find_dependencies
  -> generate_change_plan
  -> apply_script_patch or create_architecture
  -> verify_change
```

If the change is unsafe or the result has drifted, use `rollback_change`. For networked gameplay, include `get_remote_registry` and `validate_remote_contract` before editing.

## Tool reference

### `analyze_project`

**Purpose:** Rebuilds the versioned project index from live Studio evidence.

**Inputs:** None.

**Use it when:** Starting a task, after Studio changes, or when search results appear stale.

**Important behavior:** The last valid index cache is retained if rebuilding fails. This makes failed refreshes safer, but callers should still inspect the returned status and cache provenance.

### `get_project_snapshot`

**Purpose:** Returns a bounded overview of the place and indexed project.

**Inputs:**

- `refresh` — rebuild the index first.
- `include_live_place` — include current place identity from Studio.
- `include_live_tree` — include a paginated live tree.
- `tree_roots` — optional service roots to scan.
- `query` — filter by name, path, or class.
- `offset`, `limit` — pagination controls.

**Use it when:** You need project orientation, counts, remotes, modules, cache provenance, or a manageable instance list rather than a full dump.

### `inspect_instance`

**Purpose:** Batch-inspects exact Studio paths.

**Inputs:**

- `path` or `paths` — one path or up to 20 exact paths.
- `properties` — additional properties to read.
- `max_children` — child listing bound.
- `include_source` — include bounded source for scripts.
- `source_limit` — maximum source characters.

**Use it when:** You already know the exact instance path and need its properties, attributes, tags, children, or source. This is a live inspection and is more precise than ranked discovery.

### `find_system`

**Purpose:** Finds a gameplay system, module, remote, function, or feature by ranked evidence.

**Required input:** `system_name`.

**Optional inputs:** `categories`, `offset`, `limit`.

**Use it when:** You know what capability you are looking for but not where it lives. Results explain why each match ranked highly using paths, functions, attributes, dependencies, services, and remotes.

### `search_source`

**Purpose:** Searches live Luau source and returns line-numbered snippets.

**Required input:** `query`.

**Inputs:**

- `mode` — `literal`, `pattern`, `symbol`, or `method`.
- `regex` — compatibility alias for Luau pattern mode.
- `case_sensitive` — preserve case while matching.
- `roots` — service roots to scan.
- `class_names` — restrict to `Script`, `LocalScript`, or `ModuleScript`.
- `path_contains` — path substring filter.
- `context_lines` — surrounding lines, from 0 to 5.
- `offset`, `limit` — pagination.

**Use it when:** Locating remote calls, state writes, functions, API usage, or forbidden/legacy patterns before making a change.

### `read_script_context`

**Purpose:** Reads a source window with surrounding engineering context.

**Inputs:**

- `path` — exact script path; or
- `script_name` — script name or ranked search query.
- `start_line` — one-based first line.
- `line_count` — bounded number of lines.

**Output includes:** Line-numbered source, dependencies, dependents, remotes, functions, attributes, and a source hash.

**Use it when:** Reviewing a target before editing or when you need a hash for an atomic patch.

### `get_related_code`

**Purpose:** Ranks files related to a described task.

**Required input:** `task`.

**Optional inputs:** `categories`, `offset`, `limit`.

**Use it when:** A feature spans several scripts and you want field-level match evidence, relationships, services, and remote participation.

### `impact_analysis`

**Purpose:** Estimates change risk before editing.

**Required input:** `change` — path, script, or component.

**Optional input:** `max_depth` — transitive graph depth.

**Use it when:** Deciding whether a change is isolated or affects persistence, remotes, shared state, or many dependents.

### `find_dependencies`

**Purpose:** Builds direct and transitive dependency/dependent graphs.

**Required input:** `script_name`.

**Optional input:** `max_depth`.

**Output includes:** Cycles, unresolved requirements, ambiguous matches, and service usage.

**Use it when:** Tracing module boundaries, finding callers, or checking whether a refactor has hidden consumers.

### `trace_data_flow`

**Purpose:** Traces observed remote and persistence participants for a state name.

**Required input:** `variable_name`.

**Optional inputs:** `include_related`, `limit`.

**Important limitation:** It clearly separates observed evidence from inferred flow. Inference is a lead for investigation, not proof of runtime behavior.

### `get_remote_registry`

**Purpose:** Lists remotes and their known contract participants.

**Inputs:** `remote_name`, `include_unused`, `offset`, `limit`.

**Output includes:** Callers, listeners, execution sides, methods, missing peers, naming findings, and evidence coverage.

**Use it when:** Auditing or changing a RemoteEvent/RemoteFunction contract.

### `validate_remote_contract`

**Purpose:** Audits remote usage for exploit-resistant server contracts.

**Inputs:** `remote_name`, `max_scripts`, `offset`, `limit`.

**Checks include:** Runtime type validation, numeric sanity, rate limiting, server authority, verb-noun naming, missing client/server peers, and client-supplied amounts.

**Use it when:** Reviewing purchases, combat, rewards, inventory, trading, or any client/server gameplay boundary.

### `sanity_check_script`

**Purpose:** Performs a line-aware audit of supplied Luau source.

**Required input:** `script_content`.

**Optional input:** `script_name` for readable findings.

**Checks include:** `--!strict`, typed functions, lifecycle ownership, remote validation, persistence safety, forbidden APIs, unbounded yields, and modern Roblox standards.

**Use it when:** Reviewing new or proposed code that is not yet in Studio.

### `audit_lifecycle`

**Purpose:** Audits live scripts for resource and thread lifetime problems.

**Inputs:** `query`, `side` (`all`, `server`, or `client`), `offset`, `max_scripts`.

**Checks include:** Unowned connections, uncancellable tasks, unbounded yields, stale references, and missing cleanup.

### `audit_performance`

**Purpose:** Audits live scripts for high-frequency performance hazards.

**Inputs:** Same audit scope: `query`, `side`, `offset`, `max_scripts`.

**Checks include:** Per-frame allocation, cloning, repeated hierarchy scans, raycast pressure, polling, and missing pre-allocation.

### `audit_data_integrity`

**Purpose:** Audits persistence and monetization flows.

**Inputs:** Same audit scope.

**Checks include:** ProfileStore/ProfileService or DataStore session safety, `pcall` coverage, save behavior, yield safety, receipt processing, and grant-before-success ordering.

### `detect_race_conditions`

**Purpose:** Finds likely concurrency and state-ownership hazards.

**Inputs:** Same audit scope.

**Checks include:** Read-yield-use hazards, re-entrant handlers, concurrent state writes, and competing anchor authorities.

### `find_dead_code`

**Purpose:** Finds likely unused project elements without deleting anything.

**Inputs:** `kind` (`ModuleScript`, `Function`, `Remote`, or `Attribute`), `offset`, `limit`.

**Important behavior:** Results are confidence-scored candidates only. This tool never authorizes automatic deletion.

### `generate_change_plan`

**Purpose:** Produces a non-mutating implementation and verification plan.

**Required input:** `request`.

**Optional inputs:** `target`, `limit`, `max_depth`.

**Use it when:** A request affects multiple systems or you want an evidence-backed plan before editing.

### `apply_script_patch`

**Purpose:** Applies exact-text edits safely and atomically.

**Inputs:**

- `path` and `edits` for one script, or `changes` for a bounded multi-script transaction.
- `expected_source_hash` — source fingerprint precondition.
- Each edit can specify `old_text`, `new_text`, `expected_count`, and `replace_all`.
- `dry_run` — validate and preview without retaining changes.
- `idempotency_key` — required for live mutation and stable across retries.

**Safety behavior:** Match counts and source hashes prevent editing the wrong version. Idempotency prevents duplicate application. The transaction records enough state for verification and rollback.

### `create_architecture`

**Purpose:** Idempotently creates or updates project structure.

**Required input:** `nodes` — paths and class names.

**Node options:** `properties`, `attributes`, `tags`, and `source`.

**Other inputs:** `create_missing_folders`, `dry_run`, and required live-mutation `idempotency_key`.

**Safety behavior:** Dry runs validate class/property structure without changing Studio. Created instances receive transaction markers so rollback can identify what this operation created.

### `verify_change`

**Purpose:** Verifies a mutation transaction against current Studio state.

**Required input:** `transaction_id` from a mutation tool.

**Checks include:** Expected live state, rerun source sanity audits, and index drift.

**Use it when:** Immediately after a patch or architecture change, and again after a later Studio edit if the transaction is still relevant.

### `rollback_change`

**Purpose:** Reverts a recorded transaction in reverse order.

**Required input:** `transaction_id`.

**Optional inputs:** `dry_run`, `force`.

**Safety behavior:** Rollback rejects unexpected drift by default. `force` bypasses that protection and should only be used after manually reviewing the current state.

## Shared safety rules

- Reads and audits are non-mutating.
- Live mutation requires a caller-stable `idempotency_key`.
- Exact paths, source hashes, and match counts reduce the chance of editing stale code.
- Transactions are the link between mutation, verification, and rollback.
- Pagination and result bounds are intentional so large places do not produce unbounded responses.
- The server forwards official Studio MCP calls that are not custom tools.
- The server keeps MCP protocol traffic on stdout; diagnostics must not be printed there.
- If Studio MCP is unavailable or times out, mutation should be treated as unsuccessful until verified.

## Tool selection cheat sheet

| Need | Start with |
|---|---|
| Understand the project | `analyze_project`, `get_project_snapshot` |
| Find a system | `find_system`, `get_related_code` |
| Find code | `search_source`, `read_script_context` |
| Understand dependencies | `find_dependencies`, `impact_analysis` |
| Understand state movement | `trace_data_flow` |
| Review remotes | `get_remote_registry`, `validate_remote_contract` |
| Review code quality | `sanity_check_script` |
| Review live project health | `audit_lifecycle`, `audit_performance`, `audit_data_integrity`, `detect_race_conditions` |
| Find cleanup candidates | `find_dead_code` |
| Plan work | `generate_change_plan` |
| Change code/structure | `apply_script_patch`, `create_architecture` |
| Confirm or undo a change | `verify_change`, `rollback_change` |

