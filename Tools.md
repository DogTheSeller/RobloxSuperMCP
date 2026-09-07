# Roblox Super MCP Tool Guide

This is the plain-language reference for every custom tool provided by Roblox Super MCP. AI agents must also read and follow [`MCP_WORKFLOW.md`](MCP_WORKFLOW.md) before using the MCP, especially for snapshots, diffs, change notes, and visual versions.

## What the server provides

Roblox Super MCP starts the official Roblox Studio MCP and forwards its tools. It adds 29 project-aware tools for indexing, discovery, audits, private diffs, safe changes, verification, and rollback.

The custom tools fall into five groups:

1. Project index and change tracking
2. Discovery and source inspection
3. Relationships, impact, data, and remotes
4. Code and project audits
5. Planning, mutation, verification, and rollback

## Concepts used throughout this guide

### Live Studio versus the project index

Some tools read current Studio source directly. Others use `project_brain.json`, a cached index built by `analyze_project` or `refresh_project`. Indexed tools are fast and useful across the whole project, but their answers are only as current as the last successful scan.

### Read-only versus mutating tools

Almost every Super MCP tool is read-only. These tools can change Studio:

- `apply_script_patch`
- `create_architecture`
- `rollback_change`

Mutation tools create transactions. Keep their `transaction_id` so the result can be verified or safely reversed.

### Exact paths

An exact Studio path looks like:

```text
ServerScriptService.Services.PlotManager
ReplicatedStorage.Remotes.RequestPlotUpgrade
StarterGui.MainGui.Shop
```

Discovery tools help find paths. Inspection and mutation tools should receive exact paths.

### Shared output controls

Broad relationship and diff tools may accept:

- `detail`: `compact`, `normal`, or `deep`.
- `max_results`: maximum primary records/files returned.
- `max_chars`: approximate maximum response size.

Use compact first for orientation, normal for ordinary work, and deep only for a focused question. If a response reports truncation, narrow the query or request exact paths before raising limits.

### Studio selection

Every custom tool accepts `studio_id`. You may omit it when exactly one Studio is connected. If several are connected, use `list_roblox_studios` and pass the correct returned ID.

## Quick workflow

```text
analyze_project                           # build the first index
save_project_snapshot                     # private baseline before work
find_system / get_related_code            # locate likely files
search_source / read_script_context       # confirm live code
impact_analysis / relevant audits         # understand risk
apply_script_patch / create_architecture  # make a transaction
verify_change                             # confirm live result
record_project_change                     # record meaningful outcome
diff_project                              # exact +/- changelog evidence
save_project_snapshot(new visual version) # next baseline and cache rotation
```

Use only the steps relevant to the task.

---

## 1. Project index and change tracking

### `analyze_project`

**Plain English:** Builds the MCP’s searchable map of the open Roblox place from scratch.

**Use it when:** This is the first Super MCP call for a project, no cache exists, the active place changed, the cache schema is stale, or a full rebuild is requested.

**Inputs:** Only the optional common `studio_id`.

**What it scans:** `ServerScriptService`, `ReplicatedStorage`, `StarterPlayer`, `StarterGui`, `ServerStorage`, `Workspace`, and `StarterPack`.

**Returns:** Place identity, scan time, indexed counts, readable-script count, system totals, cache metadata, and scan status.

**Important behavior:** It extracts paths, classes, source hashes, functions, calls, dependencies, services, remotes, attributes, and other metadata. It does not retain full source in the project index. If scanning fails, the previous valid cache is preserved and clearly marked as fallback evidence.

**Example:**

```text
analyze_project()
```

### `refresh_project`

**Plain English:** Updates an existing project index without rebuilding unchanged script metadata.

**Use it when:** Studio changed after a successful `analyze_project`, especially before discovery, impact analysis, audits, or a final diff.

**Inputs:** Only the optional common `studio_id`.

**Returns:** Refresh duration, reused/reindexed counts, additions, deletions, moves, source changes, remote additions/deletions, and affected paths.

**Important behavior:** It still walks supported Studio roots and hashes readable source so it can detect change. Matching scripts reuse cached metadata; new or changed scripts are fully reindexed. If there is no reusable cache, it safely performs a full rebuild.

**Example:**

```text
refresh_project()
```

### `get_project_snapshot`

**Plain English:** Gives a manageable overview of the indexed project. Despite its name, it does not create the private source baseline used for changelogs.

**Use it when:** You need project identity, counts, modules, remotes, cache freshness, or a filtered list of indexed instances.

**Main inputs:**

- `refresh`: update the index before returning the overview.
- `include_live_place`: confirm current live place identity.
- `include_live_tree`: include bounded current hierarchy results.
- `tree_roots`: services included in the optional live tree.
- `query`: filter by name, path, or class.
- `offset`, `limit`: page through results.

**Returns:** A bounded overview and paginated results, with cache provenance so callers can judge freshness.

**Choose the right snapshot:** Use `get_project_snapshot` for orientation. Use `save_project_snapshot` before work when you need later `+/-` source diffs.

**Example:**

```text
get_project_snapshot(query="RemoteEvent", limit=20)
```

### `save_project_snapshot`

**Plain English:** Privately saves the current source baseline before a tracked work period.

**Use it when:** Beginning work that should appear in a later update log, or establishing the baseline for a new visual version.

**Main inputs:**

- `label`: human-readable baseline name.
- `version`: optional visual label such as `alpha v1.0.0`.
- `refresh`: refresh first; defaults to true while Studio is connected.

**Returns:** Snapshot ID, label, version, timestamp, indexed count, captured-script count, `Captured`/`Complete` state, missing/truncated counts, and private cache byte size. It never returns script source.

**Private storage:** Full readable source is kept in `.snapshot-cache/`, which is ignored by Git and reserved for internal server-side diffing. Agents must not open or quote these files.

**Version behavior:** The version is an uninterpreted display string. When a different non-empty version is saved, the tool captures a complete, untruncated replacement baseline first and only then deletes older private source caches.

**Example:**

```text
save_project_snapshot(label="Before plot update", version="alpha v1.0.0")
```

### `record_project_change`

**Plain English:** Writes a short local note explaining one completed change so the eventual changelog has intent, not only code differences.

**Use it when:** A meaningful unit of work has been implemented and verified. Usually call it once per coherent feature, fix, removal, or adjustment—not once per edited line.

**Inputs:**

- `change` (required): specific outcome and reason.
- `kind`: `added`, `removed`, `changed`, `adjusted`, `fixed`, or `internal`.
- `importance`: `breaking`, `important`, `normal`, or `minor`.
- `paths`: up to 20 exact affected Studio paths.
- `version`: optional visual version override.

**Returns:** The stored note with ID and timestamp.

**Important behavior:** This modifies only local history. It does not inspect Studio, verify the claim, or edit source. `diff_project` includes notes written after the selected baseline.

**Good example:**

```text
record_project_change(
  change="Added server-side ownership and distance validation to plot upgrades.",
  kind="fixed",
  importance="important",
  paths=["ServerScriptService.PlotManager"]
)
```

### `diff_project`

**Plain English:** Compares a private baseline with current Studio and gives the model only actual changed lines and recorded notes.

**Use it when:** Finishing a tracked work period, answering “what changed?”, or preparing a developer/player update log.

**Main inputs:**

- `snapshot_id`: baseline returned by `save_project_snapshot`; newest snapshot is used if omitted.
- `include_recorded_changes`: include notes since baseline; defaults to true.
- `refresh`: update the index first; defaults to true with live Studio.
- `paths`: optional exact scripts for a focused follow-up.
- `detail`: controls default changed-line depth.
- `max_diff_lines`: maximum `+/-` lines per script.
- `max_results`: maximum changed files.
- `max_chars`: whole response budget.

**Returns:** Added/removed/moved/changed script metadata, exact total added/removed lines when complete, per-file summaries, numbered `+/-` hunks, completeness/truncation state, and journal notes.

**Line format:** `-421 oldCall()` means old baseline line 421 was removed. `+457 newCall()` means current line 457 was added. Unchanged lines and whole current files are intentionally omitted.

**If output is truncated:** Call it again with one or more exact `paths`, `detail="deep"`, and only the additional line/character budget needed. Do not reread every script to reconstruct the changelog.

**Example:**

```text
diff_project(
  snapshot_id="...",
  paths=["ServerScriptService.PlotManager"],
  detail="deep",
  max_diff_lines=1000,
  max_chars=50000
)
```

---

## 2. Discovery and source inspection

### `inspect_instance`

**Plain English:** Reads detailed live information about exact Studio objects.

**Use it when:** You already know a path and need to verify the object before editing it or reasoning about its configuration.

**Main inputs:** `path` for one target or `paths` for up to 20; optional `properties`, `max_children`, `include_source`, and `source_limit`.

**Returns:** Whether each path exists, class/name/path, requested properties, attributes, tags, bounded children, and optional bounded source for LuaSourceContainers.

**Important behavior:** This is exact-path inspection, not fuzzy search. Find the path first with a discovery tool or the official `search_game_tree`. Request source only when needed.

**Example:**

```text
inspect_instance(
  path="ReplicatedStorage.Remotes.RequestPurchase",
  properties=["Archivable"]
)
```

### `find_system`

**Plain English:** Finds where a named gameplay system probably lives.

**Use it when:** You know the feature—plots, quests, pets, inventory, trading—but do not know its scripts, remotes, configs, or exact paths.

**Inputs:** `system_name` is required; optional `categories`, `offset`, and `limit` narrow results.

**Returns:** Ranked candidates with scores, matched terms, and field-by-field evidence from names, paths, functions, calls, dependencies, services, attributes, and remotes.

**Important behavior:** Rankings are indexed orientation, not runtime proof. Confirm selected scripts with `search_source` or `read_script_context` before editing.

**Example:**

```text
find_system(system_name="plot upgrades", limit=10)
```

### `search_source`

**Plain English:** Searches current live Luau source and returns matching lines with small surrounding snippets.

**Use it when:** You need exact confirmation of a function, call, remote, state write, deprecated API, or literal text in current Studio.

**Inputs:**

- `query` (required): text, symbol, method, or Luau pattern.
- `mode`: `literal`, `pattern`, `symbol`, or `method`.
- `regex`: compatibility alias for pattern mode.
- `case_sensitive`: exact-case matching.
- `roots`: services to search.
- `class_names`: Script/LocalScript/ModuleScript filters.
- `path_contains`: path substring filter.
- `context_lines`: 0–5 lines around matches.
- `offset`, `limit`: pagination.

**Returns:** Live paths, line numbers, snippets, scanned-script counts, pagination, and pattern errors when applicable.

**Mode guide:** Use `literal` for ordinary exact text, `symbol` for identifier boundaries, `method` for method-call syntax, and `pattern` only when a Luau pattern is genuinely required.

**Example:**

```text
search_source(query="RequestPlotUpgrade", mode="symbol", context_lines=2)
```

### `find_symbol`

**Plain English:** Uses the project index to answer “where is this function defined or called?”

**Use it when:** Locating definitions/references, finding scripts that call a function, seeing calls made by defining scripts, or obtaining a quick call graph.

**Inputs:**

- `symbol` (required): preferably qualified, such as `PlotManager:AddPlot`.
- `mode`: `definition`, `references`, `callers`, `callees`, or `graph`.
- Shared output controls.

**Returns:** Matching paths, classes, definition/call lines, occurrence counts, and graph edges depending on mode.

**Important limitation:** This is line-aware lexical analysis, not a full Luau AST. Callees belong to scripts containing a matching definition, not necessarily the exact enclosing function. Duplicate short names can be ambiguous; use qualified names and confirm important results with live source.

**Example:**

```text
find_symbol(symbol="PlotManager:AddPlot", mode="graph", detail="normal")
```

### `read_script_context`

**Plain English:** Reads part of one live script and adds useful project relationships around it.

**Use it when:** The target script is known and you need enough exact source to understand or patch it safely.

**Inputs:** `path` for an exact script or `script_name` for ranked resolution; optional `start_line` and `line_count` choose a contiguous window.

**Returns:** Line-numbered current source, live source hash, direct dependencies/dependents, remotes, functions, attributes, and truncation metadata.

**Important behavior:** Prefer one sufficiently large contiguous read over many tiny reads. Use the returned live hash as the precondition for `apply_script_patch`.

**Example:**

```text
read_script_context(
  path="ServerScriptService.PlotManager",
  start_line=1,
  line_count=350
)
```

### `get_related_code`

**Plain English:** Given a task description, suggests the files most likely needed to complete it.

**Use it when:** A request probably spans several scripts and you want a low-token shortlist before reading anything deeply.

**Inputs:** `task` is required. Optional category filters, dependency/remote toggles, pagination, and shared output controls adjust scope and detail.

**Returns:** Ranked relevant files with match evidence and collection counts. Normal/deep output may include requires, services, remotes, direct dependencies, direct dependents, and source hashes.

**Recommended pattern:** Start with `detail="compact"` and 5–10 results. Read only the strongest candidates, then increase depth for a focused follow-up.

**Example:**

```text
get_related_code(
  task="add server-authoritative plot upgrade purchasing",
  detail="compact",
  max_results=8
)
```

---

## 3. Relationships, impact, data, and remotes

### `impact_analysis`

**Plain English:** Estimates how much of the project could be affected by a proposed change.

**Use it when:** Before editing a shared module, remote contract, persistence system, widely required config, or unfamiliar component.

**Inputs:** `change` is the exact path, script name, or component; `max_depth` controls transitive dependent traversal.

**Returns:** Resolved targets, direct/transitive dependents, risk factors, ambiguity, persistence/network/shared-state evidence, and a risk summary.

**Important behavior:** It is static impact prediction. Use it to determine what needs reading and verification, not as proof that every returned component executes at runtime.

**Example:**

```text
impact_analysis(change="ServerScriptService.PlotManager", max_depth=4)
```

### `find_dependencies`

**Plain English:** Shows what a script requires and what other scripts require it.

**Use it when:** Refactoring/moving modules, tracing module consumers, investigating initialization order, or checking deletion risk.

**Inputs:** `script_name` is required and may be an exact path or name; `max_depth` controls transitive traversal.

**Returns:** Direct and transitive dependencies/dependents, cycles, unresolved requires, ambiguous targets, and service usage.

**Important behavior:** This follows indexed require relationships. Use `find_symbol` for function calls and `trace_data_flow` for remote/persistence paths.

**Example:**

```text
find_dependencies(script_name="PlotManager", max_depth=5)
```

### `trace_data_flow`

**Plain English:** Builds a static trail for a piece of state such as Coins, Inventory, PlotData, or PlayerLevel.

**Use it when:** Finding likely producers, remote transport, server consumers, and persistence participants for one state/domain term.

**Inputs:** `variable_name` is required; `include_related` adds ranked related components; `limit` bounds them.

**Returns:** Observed remote/persistence participants, inferred relationships, related components, and evidence labels.

**Important behavior:** “Observed” means syntax was indexed. “Inferred” means a likely connection requiring source/runtime confirmation. Dynamic tables and indirect calls may be invisible.

**Example:**

```text
trace_data_flow(variable_name="PlotData", include_related=true, limit=15)
```

### `get_remote_registry`

**Plain English:** Inventories RemoteEvents and RemoteFunctions and shows where each endpoint is used.

**Use it when:** Understanding client/server contracts, finding unused remotes, locating listeners/callers, or preparing to rename/delete an endpoint.

**Inputs:** Optional `remote_name`, `include_unused`, `offset`, and `limit`.

**Returns:** Remote paths/classes, Fire/Invoke/listener methods, participant scripts, inferred sides, occurrence evidence, missing peers, naming findings, and coverage.

**Important behavior:** Registry presence does not prove secure validation. Run `validate_remote_contract` for trust-boundary review.

**Example:**

```text
get_remote_registry(remote_name="RequestPurchase", include_unused=true)
```

### `validate_remote_contract`

**Plain English:** Reviews remote participants for common exploit and contract mistakes.

**Use it when:** Working on purchases, combat, inventory, rewards, trading, admin actions, or anything where the client asks the server to do something authoritative.

**Inputs:** Optional `remote_name`; `max_scripts`, `offset`, and `limit` bound live participant inspection.

**Checks:** Runtime type/range/state validation, rate limiting, server authority, suspicious client-provided numbers, verb-noun naming, and missing client/server peers.

**Returns:** Line-aware findings, severities, participant evidence, and coverage/incompleteness information.

**Important behavior:** This is a static source audit. No warnings does not prove exploit safety; manually verify the complete server path and runtime behavior.

**Example:**

```text
validate_remote_contract(remote_name="RequestPlotUpgrade", max_scripts=20)
```

---

## 4. Code and project audits

### `sanity_check_script`

**Plain English:** Checks Luau text supplied in the call before it is inserted into Studio.

**Use it when:** Reviewing generated/proposed code, or after separately reading live source that needs a focused standards check.

**Inputs:** `script_content` is required; `script_name` improves finding labels.

**Checks:** `--!strict`, typed function signatures, connection/task cleanup, remote validation, persistence safety, bounded waits, deprecated APIs, and modern Roblox replacements.

**Returns:** Line-aware findings grouped by severity and rule.

**Important behavior:** It does not fetch a script by name. The supplied `script_content` is exactly what it audits.

**Example:**

```text
sanity_check_script(script_name="PlotManager", script_content="--!strict\n...")
```

### `audit_lifecycle`

**Plain English:** Searches live scripts for resources or tasks that may outlive their owner.

**Use it when:** Adding events, player/character state, recurring tasks, delayed work, Destroy methods, or investigating memory growth.

**Inputs:** Optional script/path `query`, execution `side`, pagination `offset`, and `max_scripts`.

**Checks:** Unowned `Connect` calls, spawned work without visible cancellation, unbounded `WaitForChild`, indefinite signal waits, stale references after yields, and lifecycle owners not cleaned in Destroy.

**Returns:** Findings with paths, lines, severity/confidence, and source coverage.

**Important behavior:** Cross-module or dynamic cleanup may not be visible, so confirm warnings before changing working ownership code.

**Example:**

```text
audit_lifecycle(query="PlotManager", side="server", max_scripts=20)
```

### `lifecycle_graph`

**Plain English:** Turns a script’s connections and spawned tasks into an ownership map.

**Use it when:** You need to see which connection/task has a visible cleanup path rather than reading a flat warning list.

**Inputs:** Same scope as `audit_lifecycle`, plus shared output controls.

**Returns:** Per-script owners, connections, tasks, line numbers, visible `Disconnect`/`task.cancel`/Janitor/Trove/Maid cleanup, owned/unowned counts, and coverage.

**Important behavior:** It is lexical. Cleanup hidden behind custom abstractions or another module can be reported as unknown/unowned.

**Example:**

```text
lifecycle_graph(query="PlotManager", detail="normal", max_results=10)
```

### `audit_performance`

**Plain English:** Finds code patterns that are commonly expensive when they run frequently.

**Use it when:** Investigating potential frame-loop work, frequent cloning/allocation, repeated hierarchy scans, raycasting, polling, or missing reuse/pooling.

**Inputs:** Optional `query`, `side`, `offset`, and `max_scripts`.

**Returns:** Line-aware static findings, severities/confidence, and source coverage.

**Important behavior:** It cannot measure CPU/frame time. Use findings to choose what to profile with Chrrxs; do not rewrite working code solely because a pattern matched.

**Example:**

```text
audit_performance(query="Effects", side="client", max_scripts=25)
```

### `audit_data_integrity`

**Plain English:** Reviews persistence and receipt code for data-loss or incorrect-grant risks.

**Use it when:** Touching DataStore, ProfileStore/ProfileService, player save/load, migration, developer products, or receipt processing.

**Inputs:** Optional `query`, `side`, `offset`, and `max_scripts`.

**Checks:** Session handling, `pcall`, `UpdateAsync` versus unsafe writes, yield/failure paths, ProcessReceipt ownership, and whether rewards are granted before persistence succeeds.

**Returns:** Line-aware findings, severity/confidence, and coverage.

**Important behavior:** Persistence findings are high stakes. Read and verify the complete authoritative server flow before editing or approving it.

**Example:**

```text
audit_data_integrity(query="PlayerData", side="server", max_scripts=30)
```

### `detect_race_conditions`

**Plain English:** Looks for asynchronous code that may read stale state or have more than one writer.

**Use it when:** A system yields between reading and writing, handles re-entrant events, spawns concurrent work, or has several scripts controlling the same state/physics authority.

**Inputs:** Optional `query`, `side`, `offset`, and `max_scripts`.

**Checks:** Read-yield-use sequences, re-entrant handlers, concurrent state writes, and competing anchoring/network authorities.

**Returns:** Static findings with evidence, severity/confidence, and coverage.

**Important behavior:** Scheduling cannot be proven statically. Confirm suspected races with targeted runtime reproduction or Chrrxs debugging.

**Example:**

```text
detect_race_conditions(query="Plot", side="server", max_scripts=30)
```

### `find_dead_code`

**Plain English:** Suggests project elements that appear unused.

**Use it when:** Preparing cleanup work for modules, functions, remotes, or attributes.

**Inputs:** Optional `kind` (`ModuleScript`, `Function`, `Remote`, or `Attribute`) plus `offset` and `limit`.

**Returns:** Candidates with confidence levels and the indexed evidence supporting the conclusion.

**Important behavior:** It never authorizes deletion. Dynamic requires, string lookups, CollectionService/framework registration, plugins, and external callers may be invisible. Confirm every candidate through search and ownership review.

**Example:**

```text
find_dead_code(kind="Remote", limit=25)
```

---

## 5. Planning, mutation, verification, and rollback

### `generate_change_plan`

**Plain English:** Creates an evidence-backed implementation checklist without changing Studio.

**Use it when:** A feature/fix is multi-file, risky, unfamiliar, or benefits from an explicit verification sequence.

**Inputs:** `request` is required; optional `target`, related-file `limit`, and dependency `max_depth`.

**Returns:** Resolved targets, related files, risk/impact evidence, ordered implementation steps, and verification suggestions.

**Important behavior:** It does not read every relevant line or guarantee the plan is executable. Confirm exact paths and source immediately before mutation. Skip it for tiny obvious edits.

**Example:**

```text
generate_change_plan(
  request="Replace the legacy plot upgrade remote with a validated request flow",
  target="ServerScriptService.PlotManager"
)
```

### `apply_script_patch`

**Plain English:** Safely replaces exact text inside one or more existing Studio scripts.

**Use it when:** The current source and exact delta are known. This is the preferred Super MCP tool for script changes because it avoids whole-script rewrites.

**Single-script inputs:**

- `path`: exact script path.
- `expected_source_hash`: current hash from a live read.
- `edits`: exact `old_text`/`new_text` replacements.

**Multi-script input:** `changes`, containing up to 20 path/hash/edit groups.

**Edit controls:** `expected_count` requires an exact number of matches; `replace_all` replaces every expected occurrence.

**Transaction controls:** `dry_run` previews validation without retaining changes. Live mutation requires a caller-stable `idempotency_key`.

**Returns:** Status, changed paths/hashes, and a `transaction_id` for verification or rollback.

**Safety rules:** Use exact current text and hashes. If transport fails or the result is uncertain, retry with the same idempotency key and then verify. Never switch keys merely to force another attempt.

**Example:**

```text
apply_script_patch(
  path="ServerScriptService.PlotManager",
  expected_source_hash="...",
  edits=[{
    old_text="local price = 100",
    new_text="local price = PlotConfig.UpgradePrice",
    expected_count=1
  }],
  idempotency_key="plot-price-config-v1"
)
```

### `create_architecture`

**Plain English:** Creates or updates a declared set of Studio objects in one idempotent transaction.

**Use it when:** Adding folders, scripts, ModuleScripts, remotes, attributes, tags, or supported scalar/typed properties at exact paths.

**Inputs:**

- `nodes` (required): up to 150 entries containing `path`, `class_name`, and optional `properties`, `attributes`, `tags`, or `source`.
- `create_missing_folders`: permit creation of absent intermediate folders.
- `dry_run`: validate without parenting persistent objects.
- `idempotency_key`: required for live mutation.

**Returns:** Created/updated/unchanged nodes and a `transaction_id` for verification/rollback.

**Safety rules:** Use exact absolute paths and the intended class for every node. Set parents only through the declared path. Dry-run unfamiliar property/class combinations. Created instances receive private transaction markers so rollback removes the correct objects.

**Example:**

```text
create_architecture(
  nodes=[{
    path="ReplicatedStorage.Remotes.RequestPlotUpgrade",
    class_name="RemoteEvent"
  }],
  create_missing_folders=true,
  idempotency_key="plot-upgrade-remote-v1"
)
```

### `verify_change`

**Plain English:** Confirms that a Super MCP mutation produced the expected live Studio state.

**Use it when:** Immediately after every `apply_script_patch` or `create_architecture` call, and after an uncertain mutation result.

**Input:** `transaction_id` returned by the mutation tool.

**Returns:** Transaction/live-state comparison, changed-path verification, source sanity findings where relevant, and index drift information.

**Important behavior:** Verification is read-only and does not automatically refresh the project index. Refresh after successful verification so index-backed tools see the new state.

**Example:**

```text
verify_change(transaction_id="...")
```

### `rollback_change`

**Plain English:** Reverses a recorded Super MCP transaction in reverse order.

**Use it when:** A verified change is wrong and its transaction is still compatible with current Studio state.

**Inputs:** `transaction_id` is required; `dry_run` checks whether rollback is safe; `force` bypasses drift protection.

**Returns:** Rollback status, reverted paths/operations, drift conflicts, and resulting transaction state.

**Safety rules:** Run dry-run when other edits may have happened. Normal rollback refuses to overwrite unexpected newer state. Never use `force` automatically; it is only for an explicitly approved, manually reviewed recovery.

**Example:**

```text
rollback_change(transaction_id="...", dry_run=true)
```

## Tool selection table

| What you need | Best first tool | Common follow-up |
|---|---|---|
| Build the project index | `analyze_project` | `get_project_snapshot` |
| Update a valid index | `refresh_project` | An indexed discovery/audit tool |
| Start tracked work | `save_project_snapshot` | `record_project_change` |
| Produce changelog evidence | `diff_project` | Focused `diff_project(paths=...)` |
| Find an unfamiliar feature | `find_system` | `get_related_code` |
| Search exact current code | `search_source` | `read_script_context` |
| Find function relationships | `find_symbol` | `search_source` |
| Inspect a known object | `inspect_instance` | Official editing tool if needed |
| Estimate blast radius | `impact_analysis` | `find_dependencies` |
| Trace module requires | `find_dependencies` | `read_script_context` |
| Trace state movement | `trace_data_flow` | Remote/persistence audit |
| Inventory remotes | `get_remote_registry` | `validate_remote_contract` |
| Review supplied code | `sanity_check_script` | `apply_script_patch` |
| Review cleanup | `audit_lifecycle` | `lifecycle_graph` |
| Find static performance risks | `audit_performance` | Chrrxs runtime profiling |
| Review save/purchase safety | `audit_data_integrity` | Targeted live source review |
| Find concurrency risks | `detect_race_conditions` | Chrrxs runtime debugging |
| Find cleanup candidates | `find_dead_code` | Search and manual confirmation |
| Plan complex work | `generate_change_plan` | Live target reads |
| Patch existing scripts | `apply_script_patch` | `verify_change` |
| Create/update structure | `create_architecture` | `verify_change` |
| Confirm a transaction | `verify_change` | `refresh_project` |
| Undo a transaction | `rollback_change` | `verify_change`, then refresh |

## General safety and interpretation rules

- Read and audit tools do not modify Studio.
- Indexed evidence must be refreshed after changes.
- Static analysis identifies evidence and review targets, not guaranteed runtime truth.
- Exact paths, source hashes, match counts, and stable idempotency keys protect mutations.
- A transaction connects mutation, verification, and rollback.
- Pagination and output limits protect context on large projects.
- Never delete solely from `find_dead_code` output.
- Never treat a clean static audit as proof of security, performance, or runtime correctness.
- Never open `.snapshot-cache/`; use `diff_project` to keep full source outside model context.
- Follow workspace permission and reporting rules in addition to this guide.
