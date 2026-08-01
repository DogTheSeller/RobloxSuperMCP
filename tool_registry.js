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
import * as generateChangePlan from './tools/generate_change_plan.js';
import * as getProjectSnapshot from './tools/get_project_snapshot.js';
import * as getRelatedCode from './tools/get_related_code.js';
import * as getRemoteRegistry from './tools/get_remote_registry.js';
import * as impactAnalysis from './tools/impact_analysis.js';
import * as inspectInstance from './tools/inspect_instance.js';
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
const definition = (name, description, inputSchema) => ({ name, description, inputSchema });

const pagination = {
    offset: integer('Zero-based result offset.', 0, 100_000),
    limit: integer('Maximum results to return.', 1, 300)
};
const auditScope = {
    query: string('Optional script name/path filter.'),
    side: { type: 'string', enum: ['all', 'server', 'client'], description: 'Execution-side filter.' },
    offset: integer('Zero-based script offset.', 0, 100_000),
    max_scripts: integer('Maximum live scripts to audit.', 1, 200)
};

export const SUPER_TOOLS = [
    definition(
        'analyze_project',
        '(RECOMMENDED ENTRY POINT) Rebuilds the versioned project index from live Studio evidence and safely retains the last valid cache on failure.',
        schema({})
    ),
    definition(
        'get_project_snapshot',
        'Returns a bounded project overview with place identity, counts, remotes, modules, cache provenance, and paginated indexed instances.',
        schema({
            refresh: boolean('Run analyze_project before building the snapshot.'),
            include_live_place: boolean('Read current place identity from Studio.'),
            include_live_tree: boolean('Include a paginated live tree across supported service roots.'),
            tree_roots: stringArray('Optional live-tree service roots.', 7),
            query: string('Optional name, path, or class filter.'),
            ...pagination
        })
    ),
    definition(
        'inspect_instance',
        'Batch-inspects exact Studio paths, returning properties, attributes, tags, children, and optional bounded script source.',
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
        '(RECOMMENDED) Ranked system discovery with match evidence across paths, functions, attributes, dependencies, services, and remotes.',
        schema({
            system_name: string('Gameplay system, module, remote, function, or feature name.'),
            categories: stringArray('Optional indexed category filter.', 10),
            ...pagination
        }, ['system_name'])
    ),
    definition(
        'search_source',
        'Searches live Luau source by literal text, Luau pattern, exact symbol frontier, or method call with line-numbered snippets.',
        schema({
            query: string('Text, symbol, method, or Luau pattern to search.'),
            mode: { type: 'string', enum: ['literal', 'pattern', 'symbol', 'method'] },
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
        'read_script_context',
        'Reads a line-numbered live source window plus dependencies, dependents, remotes, functions, attributes, and source hash.',
        schema({
            path: string('Exact script path.'),
            script_name: string('Script name or ranked search query.'),
            start_line: integer('First one-based source line.', 1, 1_000_000),
            line_count: integer('Maximum source lines returned.', 1, 500)
        })
    ),
    definition(
        'get_related_code',
        'Ranks indexed files for a task with field-level match evidence, relationships, services, and remote participation.',
        schema({
            task: string('Specific engineering task or feature description.'),
            categories: stringArray('Optional indexed category filter.', 10),
            ...pagination
        }, ['task'])
    ),
    definition(
        'impact_analysis',
        '(RECOMMENDED BEFORE EDITING) Calculates change risk from direct/transitive dependents, persistence, remotes, shared state, and ambiguity.',
        schema({
            change: string('Exact path, script name, or component to modify.'),
            max_depth: integer('Maximum transitive graph depth.', 1, 12)
        }, ['change'])
    ),
    definition(
        'find_dependencies',
        'Returns direct/transitive dependency and dependent graphs with cycles, unresolved requirements, ambiguity, and service usage.',
        schema({
            script_name: string('Exact path or script name.'),
            max_depth: integer('Maximum graph depth.', 1, 12)
        }, ['script_name'])
    ),
    definition(
        'trace_data_flow',
        'Traces observed remote and persistence participants for a state name while clearly separating observation from inferred flow.',
        schema({
            variable_name: string('Variable, remote, currency, or state name.'),
            include_related: boolean('Include ranked related components.'),
            limit: integer('Maximum related components.', 1, 100)
        }, ['variable_name'])
    ),
    definition(
        'get_remote_registry',
        'Lists remotes, callers/listeners, execution sides, methods, missing peers, naming findings, and evidence coverage.',
        schema({
            remote_name: string('Optional remote-name filter.'),
            include_unused: boolean('Include endpoints without indexed participants.'),
            ...pagination
        })
    ),
    definition(
        'validate_remote_contract',
        'Audits remote contracts for runtime validation, rate limiting, server authority, naming, missing peers, and client-supplied numbers.',
        schema({
            remote_name: string('Optional remote-name filter.'),
            max_scripts: integer('Maximum participant sources to inspect.', 1, 200),
            ...pagination
        })
    ),
    definition(
        'sanity_check_script',
        'Performs a line-aware Luau audit for strict typing, lifecycle, remote validation, persistence safety, forbidden APIs, and modern standards.',
        schema({
            script_name: string('Display name or path for the script.'),
            script_content: string('Full Luau source to audit.')
        }, ['script_content'])
    ),
    definition(
        'audit_lifecycle',
        'Audits live scripts for unowned connections, uncancellable threads, unbounded yields, stale references, and missing cleanup.',
        schema(auditScope)
    ),
    definition(
        'audit_performance',
        'Audits live hot paths for per-frame allocation, cloning, hierarchy scans, raycast pressure, polling, and missing pre-allocation.',
        schema(auditScope)
    ),
    definition(
        'audit_data_integrity',
        'Audits ProfileStore/ProfileService/DataStore and receipt flows for session, pcall, persistence, yield, and grant-order safety.',
        schema(auditScope)
    ),
    definition(
        'detect_race_conditions',
        'Finds read-yield-use hazards, re-entrant handlers, concurrent state writes, and competing anchor authorities.',
        schema(auditScope)
    ),
    definition(
        'find_dead_code',
        'Returns confidence-scored unused module, function, remote, and attribute candidates without authorizing deletion.',
        schema({
            kind: { type: 'string', enum: ['ModuleScript', 'Function', 'Remote', 'Attribute'] },
            ...pagination
        })
    ),
    definition(
        'generate_change_plan',
        'Produces a non-mutating, evidence-backed implementation and verification plan for a requested feature or change.',
        schema({
            request: string('Feature, bug fix, or architectural change.'),
            target: string('Optional exact primary target.'),
            limit: integer('Maximum related files.', 1, 50),
            max_depth: integer('Maximum dependency depth.', 1, 12)
        }, ['request'])
    ),
    definition(
        'apply_script_patch',
        'Atomically applies exact-text script edits with source-hash and match-count preconditions, dry-run, idempotency, verification, and rollback.',
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
                maxItems: 20,
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        expected_source_hash: { type: 'string' },
                        edits: { type: 'array', items: { type: 'object' } }
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
        'Idempotently creates or updates folders, scripts, remotes, attributes, tags, and scalar/typed properties; created instances retain a transaction marker for safe rollback identity.',
        schema({
            nodes: {
                type: 'array',
                minItems: 1,
                maxItems: 150,
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        class_name: { type: 'string' },
                        properties: { type: 'object' },
                        attributes: { type: 'object' },
                        tags: { type: 'array', items: { type: 'string' } },
                        source: { type: 'string' }
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
        'Verifies a recorded transaction against live Studio state, reruns source sanity audits, and reports index drift.',
        schema({
            transaction_id: string('Transaction ID returned by a mutation tool.')
        }, ['transaction_id'])
    ),
    definition(
        'rollback_change',
        'Reverts a recorded transaction in reverse order with drift preconditions and optional dry-run.',
        schema({
            transaction_id: string('Transaction ID returned by a mutation tool.'),
            dry_run: boolean('Validate rollback preconditions without changing Studio.'),
            force: boolean('Bypass drift rejection. Use only after manual review.')
        }, ['transaction_id'])
    )
];

export const TOOL_HANDLERS = {
    analyze_project: analyzeProject.run,
    get_project_snapshot: getProjectSnapshot.run,
    inspect_instance: inspectInstance.run,
    find_system: findSystem.run,
    search_source: searchSource.run,
    read_script_context: readScriptContext.run,
    get_related_code: getRelatedCode.run,
    impact_analysis: impactAnalysis.run,
    find_dependencies: findDependencies.run,
    trace_data_flow: traceDataFlow.run,
    get_remote_registry: getRemoteRegistry.run,
    validate_remote_contract: validateRemoteContract.run,
    sanity_check_script: sanityCheckScript.run,
    audit_lifecycle: auditLifecycle.run,
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
