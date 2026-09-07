import * as analyzeProject from './tools/analyze_project.js';
import * as applyScriptPatch from './tools/apply_script_patch.js';
import * as auditDataIntegrity from './tools/audit_data_integrity.js';
import * as auditLifecycle from './tools/audit_lifecycle.js';
import * as auditPerformance from './tools/audit_performance.js';
import * as createArchitecture from './tools/create_architecture.js';
import * as detectRaceConditions from './tools/detect_race_conditions.js';
import * as findDeadCode from './tools/find_dead_code.js';
import * as findDependencies from './tools/find_dependencies.js';
import * as findSystem from './tools/find_system.js';
import * as findSymbol from './tools/find_symbol.js';
import * as generateChangePlan from './tools/generate_change_plan.js';
import * as getProjectSnapshot from './tools/get_project_snapshot.js';
import * as getRelatedCode from './tools/get_related_code.js';
import * as getRemoteRegistry from './tools/get_remote_registry.js';
import * as impactAnalysis from './tools/impact_analysis.js';
import * as inspectInstance from './tools/inspect_instance.js';
import * as projectHistory from './tools/project_history.js';
import * as readScriptContext from './tools/read_script_context.js';
import * as rollbackChange from './tools/rollback_change.js';
import * as sanityCheckScript from './tools/sanity_check_script.js';
import * as searchSource from './tools/search_source.js';
import * as traceDataFlow from './tools/trace_data_flow.js';
import * as validateRemoteContract from './tools/validate_remote_contract.js';
import * as verifyChange from './tools/verify_change.js';

const string = (description) => ({ type: 'string', description });
const boolean = (description) => ({ type: 'boolean', description });
const integer = (description, minimum = 0, maximum = 1000) => ({
    type: 'integer', description, minimum, maximum
});
const stringArray = (description, maxItems = 50) => ({
    type: 'array',
    description,
    maxItems,
    items: { type: 'string' }
});
const schema = (properties, required = []) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {})
});
const definition = (name, description, inputSchema) => ({
    name,
    description,
    inputSchema: {
        ...inputSchema,
        properties: {
            studio_id: string('Target Studio instance ID returned by list_roblox_studios. Omit only when exactly one Studio is connected; the server will select it automatically.'),
            ...inputSchema.properties
        }
    }
});

const pagination = {
    offset: integer('Zero-based offset into the stable result list. Use the prior response NextOffset to continue.', 0, 100_000),
    limit: integer('Maximum entries returned on this page; reduce it when inspecting a large project.', 1, 300)
};
const auditScope = {
    query: string('Optional case-insensitive script name or full-path substring. Omit to audit every eligible indexed script within the page limit.'),
    side: { type: 'string', enum: ['all', 'server', 'client'], description: 'Restrict eligible scripts by inferred execution side; defaults to all.' },
    offset: integer('Zero-based offset into the eligible indexed scripts for paged audits.', 0, 100_000),
    max_scripts: integer('Maximum live script sources to retrieve and audit in this call.', 1, 200)
};
const outputControl = {
    detail: {
        type: 'string',
        enum: ['compact', 'normal', 'deep'],
        description: 'Output depth: compact gives a low-token overview, normal gives enough evidence for ordinary work, and deep returns the fullest bounded evidence.'
    },
    max_results: integer('Maximum primary records returned before truncation. Narrow the query instead of raising this blindly.', 1, 200),
    max_chars: integer('Hard approximate character budget for the JSON response; truncated responses explain how to request more.', 1_000, 100_000)
};

export const SUPER_TOOLS = [
    definition(
        'analyze_project',
        '(READ-ONLY, FIRST-RUN ENTRY POINT) Fully scans supported Studio roots and rebuilds the local project index used by discovery, dependency, impact, remote, and audit tools. Run when no valid cache exists, the active place changed, or the schema became stale. It records metadata and source-derived hashes—not full source—and preserves the last valid cache if scanning fails.',
        schema({})
    ),
    definition(
        'refresh_project',
        '(READ-ONLY) Updates an existing project index after Studio edits. It walks supported roots to detect added, deleted, moved, and source-changed scripts or remotes, reuses cached metadata for matching source hashes, and reports exactly what was refreshed. Prefer this over analyze_project once the correct place already has a valid cache.',
        schema({})
    ),
    definition(
        'get_project_snapshot',
        '(READ-ONLY ORIENTATION; NOT A DIFF BASELINE) Returns a bounded overview of the indexed place: identity, cache age/provenance, counts, modules, remotes, and filtered instances. Use it to understand project shape without dumping the whole tree. Set refresh when the index may be stale, and request live tree data only when indexed metadata is insufficient.',
        schema({
            refresh: boolean('Incrementally refresh the index before building the overview.'),
            include_live_place: boolean('Read current place identity from Studio.'),
            include_live_tree: boolean('Include a paginated live tree across supported service roots.'),
            tree_roots: stringArray('Optional live-tree service roots.', 7),
            query: string('Optional name, path, or class filter.'),
            ...pagination
        })
    ),
    definition(
        'save_project_snapshot',
        '(READ-ONLY BASELINE CAPTURE) Use before a work period or immediately after changing the visual version. It refreshes by default, privately saves complete readable script source under .snapshot-cache, and returns only snapshot metadata—never source. Confirm SourceBaseline.Complete before relying on it. diff_project later consumes this baseline; a different non-empty visual version rotates older source caches only after a complete replacement is captured.',
        schema({
            label: string('Human-readable description of the baseline moment, such as "Before plot update" or "start-of-day".'),
            version: string('Optional visual project label such as "alpha v1.0.0". It is stored verbatim and never incremented or interpreted automatically.'),
            refresh: boolean('Refresh the project index before capturing; defaults to true with live Studio.')
        })
    ),
    definition(
        'diff_project',
        '(READ-ONLY CHANGELOG INPUT) Use after work against a save_project_snapshot baseline. It refreshes by default, privately reads current Studio source, and returns structural changes, exact numbered +/- lines, totals, and record_project_change notes without exposing unchanged or complete files. Start bounded, then use paths plus deep/max_diff_lines for specific scripts. Follow MCP_WORKFLOW.md and do not reread whole scripts merely to write the changelog.',
        schema({
            snapshot_id: string('SnapshotId returned by save_project_snapshot. Omit to use the newest metadata snapshot.'),
            include_recorded_changes: boolean('Include record_project_change notes whose timestamps are at or after the baseline; defaults to true.'),
            refresh: boolean('Refresh the project index before diffing; defaults to true with live Studio.'),
            paths: stringArray('Optional exact script paths to include in source hunks.', 50),
            max_diff_lines: integer('Maximum numbered added/removed lines returned per script. Totals still describe the complete comparison when SourceDiff.Complete is true.', 1, 10_000),
            ...outputControl
        })
    ),
    definition(
        'record_project_change',
        '(LOCAL JOURNAL; NO STUDIO MUTATION) Call once after each meaningful, verified change. Record the behavioral outcome and reason—not a vague activity log—plus kind, importance, and exact affected paths. diff_project includes notes recorded after its baseline so the model can explain intent that raw +/- lines cannot. This tool does not inspect code or change the visual version unless version is supplied.',
        schema({
            change: string('Specific completed outcome and useful reason/context. Describe behavior, not merely that a file was edited.'),
            importance: { type: 'string', enum: ['breaking', 'important', 'normal', 'minor'], description: 'Release significance, independent of change kind; defaults to normal.' },
            kind: { type: 'string', enum: ['added', 'removed', 'changed', 'adjusted', 'fixed', 'internal'], description: 'Changelog category for the completed outcome; defaults to changed.' },
            paths: stringArray('Affected exact Studio paths.', 20),
            version: string('Optional visual current project version stored verbatim. Omit to inherit the current history version.')
        }, ['change'])
    ),
    definition(
        'inspect_instance',
        '(READ-ONLY LIVE INSPECTION) Resolves one or more exact Studio paths and returns existence, class, selected properties, attributes, tags, and bounded children; script source is opt-in. Use after search/discovery has established the path, especially before editing an object. Do not use it for fuzzy discovery, and request source only when metadata is insufficient.',
        schema({
            path: string('One exact Studio instance path.'),
            paths: stringArray('Up to 20 exact Studio instance paths.', 20),
            properties: stringArray('Additional property names to read.', 50),
            max_children: integer('Maximum children returned per instance.', 1, 500),
            include_source: boolean('Include bounded source for LuaSourceContainers.'),
            source_limit: integer('Maximum source characters per script.', 0, 100_000)
        })
    ),
    definition(
        'find_system',
        '(READ-ONLY INDEXED DISCOVERY) Use when you know a gameplay concept such as plots, trading, inventory, or quests but not its exact location. It ranks indexed scripts and instances using path, function, attribute, dependency, service, and remote evidence and explains every match. Results are orientation, not proof of runtime execution; confirm critical code with live source tools.',
        schema({
            system_name: string('Gameplay system, module, remote, function, or feature name.'),
            categories: stringArray('Optional indexed category filter.', 10),
            ...pagination
        }, ['system_name'])
    ),
    definition(
        'search_source',
        '(READ-ONLY LIVE SOURCE SEARCH) Searches current Studio Luau and returns bounded, line-numbered snippets. Use literal for exact text, pattern for Luau patterns, symbol for identifier boundaries, and method for call syntax. Filter roots/classes/path when possible. Prefer this over indexed find_symbol when current-source confirmation matters; it finds text but does not resolve semantic ownership.',
        schema({
            query: string('Text, symbol, method, or Luau pattern to search.'),
            mode: { type: 'string', enum: ['literal', 'pattern', 'symbol', 'method'], description: 'literal matches exact text; pattern uses Luau patterns; symbol matches identifier boundaries; method targets method-call syntax.' },
            regex: boolean('Alias for Luau pattern mode.'),
            case_sensitive: boolean('Use case-sensitive matching.'),
            roots: stringArray('Studio service roots to scan.', 7),
            class_names: stringArray('Optional Script, LocalScript, or ModuleScript filters.', 3),
            path_contains: string('Optional case-insensitive path substring.'),
            context_lines: integer('Context lines around each match.', 0, 5),
            ...pagination
        }, ['query'])
    ),
    definition(
        'find_symbol',
        '(READ-ONLY INDEXED SYMBOL LOOKUP) Finds lexical function/method definitions, references, callers, callees, or a script-level call graph with line evidence. Use a qualified symbol such as PlotManager:AddPlot when available to reduce ambiguity. This is regex/index based, not an AST: callers and callees are associated with scripts rather than exact enclosing function scopes, so confirm ambiguous results with search_source or read_script_context.',
        schema({
            symbol: string('Function or method symbol, such as PlotManager:AddPlot or AddPlot.'),
            mode: { type: 'string', enum: ['definition', 'references', 'callers', 'callees', 'graph'], description: 'Select definitions only, all indexed references, scripts calling the symbol, calls made by defining scripts, or the combined graph.' },
            ...outputControl
        }, ['symbol'])
    ),
    definition(
        'read_script_context',
        '(READ-ONLY LIVE CODE REVIEW) Reads a bounded line-numbered window from one exact or ranked script and combines it with indexed dependencies, dependents, remotes, functions, attributes, and the live source hash. Use immediately before reasoning about or patching a known script. Prefer large contiguous windows when broad context is required; use search_source first when the target is unknown.',
        schema({
            path: string('Exact script path.'),
            script_name: string('Script name or ranked search query.'),
            start_line: integer('First one-based source line.', 1, 1_000_000),
            line_count: integer('Maximum source lines returned.', 1, 500)
        })
    ),
    definition(
        'get_related_code',
        '(READ-ONLY TASK ORIENTATION) Given a concrete engineering task, ranks the indexed files most likely involved and shows field-level match evidence. Use early for cross-file work, then inspect only the strongest candidates. compact omits heavy relationships by default; normal/deep can include dependencies, dependents, services, remotes, and hashes within explicit result/character budgets.',
        schema({
            task: string('Specific engineering task or feature description.'),
            categories: stringArray('Optional indexed category filter.', 10),
            include_dependencies: boolean('Include direct dependencies and dependents.'),
            include_remotes: boolean('Include remote participation.'),
            ...outputControl,
            ...pagination
        }, ['task'])
    ),
    definition(
        'impact_analysis',
        '(READ-ONLY, RECOMMENDED BEFORE EDITING) Estimates the blast radius of changing an exact path, script, or component. It follows direct/transitive dependents and raises risk for persistence, networking, shared state, or ambiguous resolution. Use the result to choose verification scope; it predicts static impact and does not prove runtime behavior.',
        schema({
            change: string('Exact path, script name, or component to modify.'),
            max_depth: integer('Maximum transitive graph depth.', 1, 12)
        }, ['change'])
    ),
    definition(
        'find_dependencies',
        '(READ-ONLY INDEX GRAPH) Resolves a script and returns what it requires plus what requires it, optionally transitively to max_depth. It also exposes cycles, unresolved/ambiguous require targets, and service usage. Use for refactors, module moves, deletion checks, and dependency tracing; use find_symbol for function-call evidence instead.',
        schema({
            script_name: string('Exact path or script name.'),
            max_depth: integer('Maximum graph depth.', 1, 12)
        }, ['script_name'])
    ),
    definition(
        'trace_data_flow',
        '(READ-ONLY STATIC TRACE) Finds scripts, remotes, and persistence participants associated with a state or domain term such as Coins, Inventory, or PlotData. It separates directly observed calls/usages from inferred relationships and can include ranked related components. Use it to form an investigation path, then verify important transitions in live source or runtime tools.',
        schema({
            variable_name: string('Variable, remote, currency, or state name.'),
            include_related: boolean('Include ranked related components.'),
            limit: integer('Maximum related components.', 1, 100)
        }, ['variable_name'])
    ),
    definition(
        'get_remote_registry',
        '(READ-ONLY REMOTE INVENTORY) Lists indexed RemoteEvents/RemoteFunctions and known Fire/Invoke/listener participants with script paths, execution sides, methods, and evidence coverage. It flags unused endpoints, missing client/server peers, and naming concerns. Use before changing or deleting a remote; use validate_remote_contract for security checks inside participant source.',
        schema({
            remote_name: string('Optional remote-name filter.'),
            include_unused: boolean('Include endpoints without indexed participants.'),
            ...pagination
        })
    ),
    definition(
        'validate_remote_contract',
        '(READ-ONLY LIVE SECURITY AUDIT) Reads bounded source for remote participants and checks server-side type/range/state validation, rate limiting, authority, naming, missing peers, and suspicious client-supplied values. Use for purchases, combat, inventory, trading, rewards, or any trust boundary. Findings are static review targets; absence of a warning is not proof that a remote is exploit-safe.',
        schema({
            remote_name: string('Optional remote-name filter.'),
            max_scripts: integer('Maximum participant sources to inspect.', 1, 200),
            ...pagination
        })
    ),
    definition(
        'sanity_check_script',
        '(READ-ONLY PROVIDED-SOURCE AUDIT) Audits the script_content supplied in the call; it does not fetch Studio source itself. Returns line-aware findings for strict typing, lifecycle cleanup, remote validation, persistence safety, bounded yields, forbidden APIs, and modern Roblox practices. Use on proposed/generated code or feed it verified live source before applying a patch.',
        schema({
            script_name: string('Display name or path for the script.'),
            script_content: string('Full Luau source to audit.')
        }, ['script_content'])
    ),
    definition(
        'audit_lifecycle',
        '(READ-ONLY LIVE STATIC AUDIT) Retrieves selected Studio scripts and reports unowned signal connections, uncancellable spawned work, unbounded waits, stale-reference-after-yield risks, and missing owner cleanup. Scope by query/side and page large projects. Findings are lexical and may require manual confirmation when cleanup is delegated to another module.',
        schema(auditScope)
    ),
    definition(
        'lifecycle_graph',
        '(READ-ONLY LIVE OWNERSHIP MAP) Produces a per-script map of signal connections and task.spawn/defer/delay work, linking visible Disconnect, task.cancel, Janitor, Trove, or Maid ownership. Use when reviewing one system’s cleanup flow after audit_lifecycle or before editing its lifetime logic. Dynamic or cross-module cleanup can remain unknown.',
        schema({ ...auditScope, ...outputControl })
    ),
    definition(
        'audit_performance',
        '(READ-ONLY LIVE STATIC PERFORMANCE AUDIT) Scans selected script source for likely hot-path costs: allocation/cloning in frame callbacks, repeated hierarchy searches, raycast pressure, polling, and missing pre-allocation. Use to identify profiling candidates, not as a substitute for runtime measurements; confirm material findings with the runtime profiler before large rewrites.',
        schema(auditScope)
    ),
    definition(
        'audit_data_integrity',
        '(READ-ONLY LIVE PERSISTENCE AUDIT) Reviews selected ProfileStore/ProfileService/DataStore and Marketplace receipt code for session handling, pcall coverage, unsafe SetAsync/save patterns, yielding hazards, and grant-before-save ordering. Use before changing player data or monetization. Treat findings as high-priority review targets and verify the full authoritative server flow.',
        schema(auditScope)
    ),
    definition(
        'detect_race_conditions',
        '(READ-ONLY LIVE CONCURRENCY AUDIT) Looks for static evidence of read-yield-use hazards, re-entrant event handlers, concurrent writes to shared state, and multiple authorities changing anchoring or ownership. Use on asynchronous gameplay systems and after adding yields. It cannot observe scheduling at runtime, so confirm suspected races through targeted debugging.',
        schema(auditScope)
    ),
    definition(
        'find_dead_code',
        '(READ-ONLY CANDIDATE FINDER) Uses indexed references to report potentially unused ModuleScripts, functions, remotes, or attributes with confidence and evidence. Use to build a manual cleanup shortlist. Dynamic require paths, string-based access, framework registration, and external consumers can be invisible, so never delete solely because this tool reports a candidate.',
        schema({
            kind: { type: 'string', enum: ['ModuleScript', 'Function', 'Remote', 'Attribute'], description: 'Optional candidate type; omit to return all supported dead-code candidate kinds.' },
            ...pagination
        })
    ),
    definition(
        'generate_change_plan',
        '(READ-ONLY PLANNING) Combines related-code ranking and impact evidence into a deterministic implementation and verification plan for a feature, bug fix, or architectural change. Use for multi-file or risky work after the index is current. It does not inspect every source line or mutate Studio; validate targets with live reads before execution.',
        schema({
            request: string('Feature, bug fix, or architectural change.'),
            target: string('Optional exact primary target.'),
            limit: integer('Maximum related files.', 1, 50),
            max_depth: integer('Maximum dependency depth.', 1, 12)
        }, ['request'])
    ),
    definition(
        'apply_script_patch',
        '(MUTATES SCRIPT SOURCE) Atomically applies exact old_text -> new_text replacements to one or several exact Studio script paths. Live use requires current source-hash preconditions and a caller-stable idempotency_key; match counts prevent broad accidental replacement. Prefer dry_run first for risky edits. Success returns a transaction_id for verify_change or rollback_change—never retry with a new key when outcome is uncertain.',
        schema({
            path: string('Exact script path for a single-script patch.'),
            expected_source_hash: string('Required live source fingerprint when available.'),
            edits: {
                type: 'array',
                maxItems: 100,
                items: schema({
                    old_text: string('Exact existing source text.'),
                    new_text: string('Replacement source text.'),
                    expected_count: integer('Required exact match count.', 1, 10_000),
                    replace_all: boolean('Replace all expected matches.')
                }, ['old_text', 'new_text'])
            },
            changes: {
                type: 'array',
                description: 'Atomic multi-script alternative to top-level path/expected_source_hash/edits. Each exact path may appear only once.',
                maxItems: 20,
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Exact absolute Studio script path.' },
                        expected_source_hash: { type: 'string', description: 'Current live source hash required as the precondition for this script.' },
                        edits: { type: 'array', description: 'Exact-text edits using the same shape as top-level edits.', items: { type: 'object' } }
                    },
                    required: ['path', 'edits']
                }
            },
            dry_run: boolean('Validate and preview without retaining mutations.'),
            idempotency_key: string('Required for live mutation; caller-stable key preventing duplicate application.')
        })
    ),
    definition(
        'create_architecture',
        '(MUTATES STUDIO STRUCTURE) Idempotently creates or updates an explicit manifest of folders, scripts, remotes, attributes, tags, and supported properties. Use exact absolute paths; set create_missing_folders only when intended. Live use requires an idempotency_key and returns a transaction_id. dry_run validates without parenting changes, and created instances receive rollback identity markers.',
        schema({
            nodes: {
                type: 'array',
                description: 'Desired exact Studio manifest. Existing matching nodes are updated; absent nodes are created.',
                minItems: 1,
                maxItems: 150,
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Exact absolute dot path for the desired instance.' },
                        class_name: { type: 'string', description: 'Roblox class to require or create, such as Folder, ModuleScript, or RemoteEvent.' },
                        properties: { type: 'object', description: 'Supported property values to set when they differ.' },
                        attributes: { type: 'object', description: 'Attributes to set on the target instance.' },
                        tags: { type: 'array', description: 'CollectionService tags to ensure are present.', items: { type: 'string' } },
                        source: { type: 'string', description: 'Complete initial/desired source for Script, LocalScript, or ModuleScript nodes.' }
                    },
                    required: ['path', 'class_name']
                }
            },
            create_missing_folders: boolean('Create absent intermediate folders.'),
            dry_run: boolean('Perform a non-mutating preview with unparented class/property validation.'),
            idempotency_key: string('Required for live mutation; caller-stable key preventing duplicate application.')
        }, ['nodes'])
    ),
    definition(
        'verify_change',
        '(READ-ONLY POST-MUTATION CHECK) Given a transaction_id from apply_script_patch or create_architecture, compares expected changes with live Studio, reruns relevant source sanity checks, and reports drift from the project index. Call immediately after mutation and before claiming success. Verification does not refresh the project cache automatically.',
        schema({
            transaction_id: string('Transaction ID returned by a mutation tool.')
        }, ['transaction_id'])
    ),
    definition(
        'rollback_change',
        '(MUTATES STUDIO BY REVERSING A TRANSACTION) Replays a recorded transaction backward, restoring prior script source/properties and removing only safely identified created instances. It rejects drift by default so newer user work is not overwritten. Use dry_run first when state may have changed; force bypasses protection and is only for explicit, manually reviewed recovery.',
        schema({
            transaction_id: string('Transaction ID returned by a mutation tool.'),
            dry_run: boolean('Validate rollback preconditions without changing Studio.'),
            force: boolean('Bypass drift rejection. Use only after manual review.')
        }, ['transaction_id'])
    )
];

export const TOOL_HANDLERS = {
    analyze_project: analyzeProject.run,
    refresh_project: analyzeProject.refresh,
    get_project_snapshot: getProjectSnapshot.run,
    save_project_snapshot: projectHistory.saveSnapshot,
    diff_project: projectHistory.diffProject,
    record_project_change: projectHistory.recordChange,
    inspect_instance: inspectInstance.run,
    find_system: findSystem.run,
    search_source: searchSource.run,
    find_symbol: findSymbol.run,
    read_script_context: readScriptContext.run,
    get_related_code: getRelatedCode.run,
    impact_analysis: impactAnalysis.run,
    find_dependencies: findDependencies.run,
    trace_data_flow: traceDataFlow.run,
    get_remote_registry: getRemoteRegistry.run,
    validate_remote_contract: validateRemoteContract.run,
    sanity_check_script: sanityCheckScript.run,
    audit_lifecycle: auditLifecycle.run,
    lifecycle_graph: auditLifecycle.graph,
    audit_performance: auditPerformance.run,
    audit_data_integrity: auditDataIntegrity.run,
    detect_race_conditions: detectRaceConditions.run,
    find_dead_code: findDeadCode.run,
    generate_change_plan: generateChangePlan.run,
    apply_script_patch: applyScriptPatch.run,
    create_architecture: createArchitecture.run,
    verify_change: verifyChange.run,
    rollback_change: rollbackChange.run
};
