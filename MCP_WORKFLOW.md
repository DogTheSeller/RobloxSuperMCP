# Roblox Super MCP Agent Workflow

This file is the operating contract for agents using Roblox Super MCP. Read it before the first Super MCP call in a task. Read the snapshot, diff, journal, and visual-version sections again before preparing an update log or changing a version.

Project-specific user instructions and the workspace `AGENTS.md` still take precedence. Roblox Super MCP does not relax any permission, path-verification, security, testing, or reporting requirement defined there.

## What Roblox Super MCP is for

Roblox Super MCP sits in front of the official Roblox Studio MCP. It adds a persistent project index, ranked code discovery, dependency and remote analysis, static audits, private change snapshots, exact source diffs, and transaction-aware mutations.

Use each MCP for its intended job:

| MCP | Primary responsibility | Do not use it for |
|---|---|---|
| `Roblox_Studio` / official forwarded tools | Exact live hierarchy searches, direct script reads, instance inspection, ordinary script/instance editing, console access | Historical project diffs or cached architectural reasoning |
| Roblox Super MCP custom tools | Project-wide indexed discovery, impact/dependency reasoning, audits, private snapshot/diff workflow, transactional changes | Runtime profiling or pretending indexed evidence is runtime proof |
| `Chrrxs_Debug` | Live playtest logs, breakpoints, temporary runtime evaluation, profiler and memory inspection | Normal hierarchy discovery, persistent source editing, or automatic playtest control |

The normal Studio MCP remains the authority for current DataModel state. The Super MCP index is a search and reasoning aid whose freshness must be checked.

## Local files and privacy boundaries

Roblox Super MCP maintains four local data areas:

| Local data | Purpose | May the agent read or quote it directly? |
|---|---|---|
| `project_brain.json` | Versioned project index containing paths, hashes, functions, calls, dependencies, remotes, attributes, and counts | Use through Super MCP tools; do not treat it as fresher than Studio |
| `project_history.json` | Snapshot metadata, visual version labels, and `record_project_change` notes | Use through snapshot/diff tools |
| `.snapshot-cache/` | Temporary full source baselines used internally for exact line diffs | **No. Never open, print, summarize, or place it in model context** |
| `.transactions/` | Mutation preconditions, prior values, expected results, and rollback state | Use through verify/rollback tools; do not edit manually |

These paths are ignored by Git. The private source cache exists so tens of thousands of source lines can remain on disk while the model receives only changed `+/-` lines.

`save_project_snapshot` never returns cached source. `diff_project` privately fetches current Studio source, compares it inside the MCP server, and returns only structural information, changed lines, and recorded notes. Do not bypass this boundary for convenience.

## Studio selection and index freshness

Every live operation must target the correct Studio instance.

1. If exactly one Studio is connected, custom tools select it automatically.
2. If more than one is connected, call `list_roblox_studios`, identify the intended place by its returned name/place ID, and pass its `studio_id`.
3. Never choose between multiple places by guessing.

Index rules:

- Use `analyze_project` when no cache exists, the schema is stale, the active place changed, or a full rebuild is explicitly needed.
- Use `refresh_project` after normal Studio edits. It walks supported roots but reuses unchanged indexed metadata.
- Check `Status`, `LiveScanError`, `PlaceIdentity`, cache age, and incomplete-scan fields before trusting results.
- A retained old cache after a failed scan is fallback evidence, not confirmation of current Studio state.
- `save_project_snapshot` and `diff_project` refresh automatically when Studio is connected. Set `refresh=false` only for deliberate offline/test behavior.

## Standard engineering workflow

Not every task requires every tool. Use the shortest applicable route while preserving required verification.

### 1. Orient

```text
analyze_project()             # first use or invalid cache
refresh_project()             # later work
get_project_snapshot()        # bounded project overview when needed
```

`get_project_snapshot` is an overview. It is **not** the private baseline used by `diff_project`; that is `save_project_snapshot`.

### 2. Start a tracked work period

Call:

```text
save_project_snapshot(
  label = "Start of plot-system work",
  version = "alpha v1.0.0"
)
```

Keep the returned `SnapshotId`. The tool refreshes the index, captures all readable script source privately, and reports only counts/bytes. Confirm both `SourceBaseline.Captured` and `SourceBaseline.Complete` are true. Otherwise exact historical source diffing may be unavailable or incomplete, and a visual-version change will not rotate the last complete baseline.

The label should describe the baseline. The version is optional and visual only.

### 3. Discover before reading broadly

Use the cheapest tool that answers the question:

- Unknown system location: `find_system`.
- Files relevant to a concrete task: `get_related_code` with `detail="compact"` first.
- Exact live text or API usage: `search_source`.
- Function definition/call relationships: `find_symbol`; remember it is lexical, not AST-based.
- Exact known script: `read_script_context`.
- Exact known instance: `inspect_instance`.
- Module relationships: `find_dependencies`.
- Change blast radius: `impact_analysis` before editing.
- State/remote/persistence path: `trace_data_flow`.

Do not dump the entire project when a ranked or filtered query is sufficient.

### 4. Audit the relevant risk

Choose only audits related to the change:

- Remotes and trust boundaries: `get_remote_registry`, then `validate_remote_contract`.
- Proposed source not yet in Studio: `sanity_check_script`.
- Connection/task cleanup: `audit_lifecycle`, then `lifecycle_graph` for ownership detail.
- Suspected static performance hazards: `audit_performance`; confirm meaningful findings with Chrrxs runtime profiling.
- Persistence or purchase work: `audit_data_integrity`.
- Async/shared-state work: `detect_race_conditions`.
- Cleanup candidates: `find_dead_code`, followed by manual evidence confirmation.

Static findings are review targets. They are not runtime proof and do not authorize deletion.

### 5. Plan and mutate

Use `generate_change_plan` for multi-file, risky, or unfamiliar work. Small obvious edits do not need a ceremonial plan.

Only these Super MCP operations mutate Studio:

- `apply_script_patch` changes existing script source through exact delta edits.
- `create_architecture` creates or updates declared instances/properties/source.
- `rollback_change` reverses a prior Super MCP transaction.

For mutations:

1. Verify exact paths and read the current target first.
2. Use current source hashes and exact match counts where applicable.
3. Use `dry_run` before risky or broad changes.
4. Supply a caller-stable `idempotency_key` for live mutation.
5. If a call has an uncertain outcome, retry with the same key; never invent a new key.
6. Keep the returned `transaction_id`.
7. Call `verify_change` before claiming success.
8. Refresh the project index after verified changes.

### 6. Record meaningful changes

After each meaningful, completed, verified unit of work, call `record_project_change` once:

```text
record_project_change(
  change = "Added server-authoritative plot upgrades with distance and ownership validation.",
  kind = "added",
  importance = "important",
  paths = [
    "ServerScriptService.PlotManager",
    "ReplicatedStorage.Remotes.RequestPlotUpgrade"
  ]
)
```

A useful note states:

- What behavior was added, removed, fixed, or adjusted.
- Why it changed when the reason is not obvious.
- Important compatibility, migration, security, or player-facing consequences.
- Exact affected Studio paths.

Do not record vague notes such as “edited PlotManager,” raw implementation chatter, failed attempts, or every individual line replacement. Group one coherent completed change into one note.

Kinds:

- `added` — new player-facing or internal functionality.
- `removed` — deleted behavior, content, or obsolete systems.
- `changed` — materially different behavior or architecture.
- `adjusted` — balancing, tuning, or small behavioral revisions.
- `fixed` — bug fixes and regressions.
- `internal` — refactors, tooling, cleanup, or other non-player-facing work.

Importance is separate:

- `breaking` — compatibility, data, contract, or behavior break requiring attention.
- `important` — major player-facing or architectural change.
- `normal` — ordinary completed work.
- `minor` — small adjustment or internal detail.

Recording a note does not inspect or modify Studio. Notes supplement source evidence; they do not replace verification.

## Private source diff and changelog workflow

At the end of the tracked period, call:

```text
diff_project(
  snapshot_id = "<SnapshotId from save_project_snapshot>",
  include_recorded_changes = true,
  detail = "normal"
)
```

The tool automatically refreshes the index, identifies added/removed/moved/changed scripts, reads only the current source needed for comparison, and compares it with the private baseline. The model receives no unchanged full files.

A file diff resembles:

```text
ServerScriptService.PlotManager [+ 915, - 108]

-421 function oldHandler()
+457 function upgradePlot()
+458     applyUpgrade()
```

The sign comes first and the number is the source line in its respective version:

- `-421` means baseline line 421 was removed.
- `+457` means current line 457 was added.
- Unchanged context lines are intentionally omitted.

### Output controls

- `detail="compact"` — quick orientation; defaults to 20 changed lines per script.
- `detail="normal"` — ordinary changelog work; defaults to 100 changed lines per script.
- `detail="deep"` — focused investigation; defaults to 1,000 changed lines per script.
- `max_diff_lines` — explicit maximum returned `+/-` lines per script.
- `max_results` — maximum changed files returned.
- `max_chars` — approximate whole-response character limit.
- `paths` — exact scripts to include in a focused follow-up.
- `include_recorded_changes=false` — omit journal notes only when they are intentionally unwanted.

Start with normal or compact. If `ChangedLinesTruncated` is nonzero, `ReturnedFiles` is below the changed-file count, or the overall output is truncated, call `diff_project` again with selected `paths` and a larger bounded budget. Do not respond by reading every current script.

### Evidence and failure rules

- Trust exact `LinesAdded`/`LinesRemoved` only when `LineCountEvidence` is `exact-source-diff` and `SourceDiff.Complete` is true.
- If the baseline source cache was rotated, predates private snapshots, belongs to another place, or contains unavailable/truncated source, report the limitation.
- Never invent behavioral meaning from a hash, filename, or line count alone.
- Use `RecordedChanges` to understand intent and `FileDiffs` to verify concrete code movement.
- If notes and code conflict, report the conflict instead of silently choosing one.
- Do not call `script_read`, `read_script_context`, or equivalent whole-file readers merely to reconstruct the update log. A targeted read is allowed only for a separate engineering/debugging need or when the user explicitly requests it.

## Visual versions and cache rotation

Versions such as `alpha v1.0.0`, `beta v1.0.0`, or any custom label are display values for the user. Roblox Super MCP does not interpret semantic versions, decide release significance, or increment them automatically.

Rules:

1. Preserve the current version string unless the user or project instructions request a change.
2. Do not silently convert `alpha v1.0.0` into another format.
3. Saving another snapshot with the same version keeps eligible baselines within normal history retention.
4. Saving a snapshot with a different non-empty version first captures the replacement source baseline, then removes older private source-cache files.
5. Metadata history and notes remain bounded separately: up to 20 snapshots and 500 notes.
6. If replacement capture fails, do not claim that the version transition or cache rotation completed.

Recommended transition:

```text
diff_project(old_snapshot_id)                     # produce the completed-period evidence
save_project_snapshot(label, version="new label") # establish the next baseline and rotate old source
```

The final snapshot of one version can be the starting baseline for the next work period.

## Writing the update log

Use only evidence from `FileDiffs`, structural changes, and `RecordedChanges`. Prefer these sections when supported and omit empty sections:

1. Major additions
2. Added
3. Important changes
4. Changes and adjustments
5. Fixes
6. Removed
7. Internal changes

Write for the requested audience. A player-facing update log should describe behavior and omit implementation noise. A developer log may include affected systems, migrations, remote contracts, and measured line totals.

Distinguish:

- **Observed:** directly present in returned changed lines or structural metadata.
- **Recorded intent:** explicitly stated in a journal note.
- **Inferred:** a reasonable interpretation that still needs confirmation.

Never present inferred behavior as certain.

## Failure recovery

- Wrong or ambiguous Studio: stop and resolve the correct `studio_id`.
- Scan failed but old cache loaded: do not use it as proof of current state; reconnect Studio and refresh.
- Snapshot reports `Captured: false`: exact later source diffs are unavailable; capture a valid baseline before continuing tracked work.
- Diff reports incomplete/truncated data: narrow with `paths` and raise only the necessary bounds.
- Mutation timed out or transport closed: treat outcome as uncertain, retry with the same idempotency key, then verify.
- Verification reports drift: inspect current state before rollback or further mutation.
- Rollback reports drift: use dry-run/manual review; never force automatically.

## Complete example

```text
1. analyze_project()
2. save_project_snapshot(label="Before quest update", version="alpha v1.3.0")
3. find_system(system_name="quests")
4. get_related_code(task="add daily quest rerolls", detail="compact")
5. impact_analysis(change="ServerScriptService.QuestService")
6. read_script_context(path="ServerScriptService.QuestService", ...)
7. apply_script_patch(..., dry_run=true)
8. apply_script_patch(..., idempotency_key="quest-reroll-v1")
9. verify_change(transaction_id="...")
10. record_project_change(
      change="Added server-authoritative daily quest rerolls with validated costs.",
      kind="added",
      importance="important",
      paths=["ServerScriptService.QuestService"]
    )
11. diff_project(snapshot_id="...", detail="normal")
12. diff_project(snapshot_id="...", paths=["ServerScriptService.QuestService"], detail="deep")
    # only if the first result was truncated or more evidence is needed
13. Write the update log from returned +/- lines and notes.
14. save_project_snapshot(label="After quest update", version="alpha v1.3.1")
```

The goal is bounded evidence: index broadly, inspect narrowly, mutate atomically, verify explicitly, record meaningfully, and expose only the source differences needed for the final changelog.
