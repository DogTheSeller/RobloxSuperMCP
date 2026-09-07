import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const transactionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-super-mcp-test-'));
const historyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-super-mcp-history-test-'));
const sourceCacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-super-mcp-source-test-'));
process.env.ROBLOX_SUPER_MCP_BRAIN_PATH = path.join(__dirname, 'fixture_brain.json');
process.env.ROBLOX_SUPER_MCP_TRANSACTION_PATH = transactionDirectory;
process.env.ROBLOX_SUPER_MCP_HISTORY_PATH = path.join(historyDirectory, 'project_history.json');
process.env.ROBLOX_SUPER_MCP_SOURCE_CACHE_PATH = sourceCacheDirectory;

const { SUPER_TOOLS, TOOL_HANDLERS } = await import('../tool_registry.js');
const applyScriptPatch = await import('../tools/apply_script_patch.js');
const auditDataIntegrity = await import('../tools/audit_data_integrity.js');
const auditLifecycle = await import('../tools/audit_lifecycle.js');
const auditPerformance = await import('../tools/audit_performance.js');
const brainStore = await import('../tools/brain_store.js');
const createArchitecture = await import('../tools/create_architecture.js');
const detectRaceConditions = await import('../tools/detect_race_conditions.js');
const findDeadCode = await import('../tools/find_dead_code.js');
const findSymbol = await import('../tools/find_symbol.js');
const generateChangePlan = await import('../tools/generate_change_plan.js');
const getProjectSnapshot = await import('../tools/get_project_snapshot.js');
const getRelatedCode = await import('../tools/get_related_code.js');
const inspectInstance = await import('../tools/inspect_instance.js');
const projectHistory = await import('../tools/project_history.js');
const readScriptContext = await import('../tools/read_script_context.js');
const remoteUtils = await import('../tools/remote_utils.js');
const rollbackChange = await import('../tools/rollback_change.js');
const searchSource = await import('../tools/search_source.js');
const studioUtils = await import('../tools/studio_utils.js');
const transactionStore = await import('../tools/transaction_store.js');
const validateRemoteContract = await import('../tools/validate_remote_contract.js');
const verifyChange = await import('../tools/verify_change.js');

const TEST_PLACE_IDENTITY = {
    Name: 'SuperMCP Test Place',
    PlaceId: 123,
    GameId: 456,
    CreatorId: 789
};

function normalizeSourceResponse(value, args) {
    if (!args.code.includes('SourceChunk')) return value;
    const sourceRecords = Array.isArray(value) ? value : value?.Records;
    if (!Array.isArray(sourceRecords) || !sourceRecords.every(record => typeof record.Source === 'string')) {
        return value;
    }
    return {
        Records: sourceRecords.map(record => ({
            Path: record.Path,
            Name: record.Name || record.Path.split('.').at(-1),
            ClassName: record.ClassName || 'Script',
            SourceChunk: record.Source,
            SourceOffset: 0,
            ChunkComplete: true,
            Truncated: record.Truncated === true,
            SourceHash: record.SourceHash,
            SourceLength: record.SourceLength ?? Buffer.byteLength(record.Source, 'utf8')
        })),
        PlaceIdentity: value?.PlaceIdentity || TEST_PLACE_IDENTITY
    };
}

function communicatorReturning(value) {
    return {
        isAlive: () => true,
        callTool: async (name, args) => {
            assert.equal(name, 'execute_luau');
            assert.equal(args.datamodel_type, 'Edit');
            const responseValue = normalizeSourceResponse(value, args);
            return {
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(responseValue)
                    }]
                }
            };
        }
    };
}

function communicatorSequence(values) {
    const queue = [...values];
    return {
        isAlive: () => true,
        callTool: async (name, args) => {
            assert.equal(name, 'execute_luau');
            assert.equal(args.datamodel_type, 'Edit');
            if (queue.length === 0) throw new Error('Unexpected extra Studio call in test.');
            const responseValue = normalizeSourceResponse(queue.shift(), args);
            return {
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(responseValue)
                    }]
                }
            };
        }
    };
}

test.after(() => {
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
    fs.rmSync(historyDirectory, { recursive: true, force: true });
    fs.rmSync(sourceCacheDirectory, { recursive: true, force: true });
});

test('registry exposes 29 unique implemented custom tools', () => {
    const names = SUPER_TOOLS.map(tool => tool.name);
    assert.equal(names.length, 29);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
        assert.equal(typeof TOOL_HANDLERS[name], 'function', `${name} has a handler`);
    }
    for (const expected of [
        'get_project_snapshot', 'inspect_instance', 'read_script_context', 'search_source',
        'apply_script_patch', 'create_architecture', 'validate_remote_contract',
        'audit_lifecycle', 'audit_performance', 'audit_data_integrity',
        'detect_race_conditions', 'find_dead_code', 'generate_change_plan',
        'verify_change', 'rollback_change', 'refresh_project', 'find_symbol',
        'save_project_snapshot', 'diff_project', 'record_project_change', 'lifecycle_graph'
    ]) {
        assert.ok(names.includes(expected), `${expected} is registered`);
    }
});

test('Studio payload parser unwraps nested JSON strings', () => {
    const parsed = studioUtils.parseStudioPayload({
        result: { content: [{ type: 'text', text: '"{\\"Ok\\":true}"' }] }
    });
    assert.deepEqual(parsed, { Ok: true });
});

test('Studio payload helpers use command-parser-safe JSON and surface MCP tool errors', () => {
    const value = { text: 'quotes " and brackets ]]', lines: ['one', 'two'] };
    assert.equal(JSON.parse(studioUtils.luaJson(value)), JSON.stringify(value));
    assert.throws(() => studioUtils.parseStudioPayload({
        result: { isError: true, content: [{ type: 'text', text: 'Failed to parse command code' }] }
    }, 'Studio scan'), /Failed to parse command code/);
});

test('paged source retrieval assembles response-safe chunks', async () => {
    const communicator = communicatorSequence([
        {
            Records: [{
                Path: 'ServerScriptService.Big',
                Name: 'Big',
                ClassName: 'Script',
                SourceChunk: 'abc',
                SourceOffset: 0,
                ChunkComplete: false,
                Truncated: false,
                SourceHash: '6:test',
                SourceLength: 6
            }],
            Next: { PathIndex: 1, SourceOffset: 3 },
            PlaceIdentity: TEST_PLACE_IDENTITY
        },
        {
            Records: [{
                Path: 'ServerScriptService.Big',
                Name: 'Big',
                ClassName: 'Script',
                SourceChunk: 'def',
                SourceOffset: 3,
                ChunkComplete: true,
                Truncated: false,
                SourceHash: '6:test',
                SourceLength: 6
            }],
            PlaceIdentity: TEST_PLACE_IDENTITY
        }
    ]);
    const records = await studioUtils.fetchScriptSources(
        communicator,
        ['ServerScriptService.Big'],
        { maxScripts: 1 }
    );
    assert.equal(records[0].Source, 'abcdef');
});

test('paged source retrieval preserves UTF-8 byte cursors', async () => {
    const communicator = communicatorSequence([
        {
            Records: [{
                Path: 'ServerScriptService.Unicode',
                Name: 'Unicode',
                ClassName: 'Script',
                SourceChunk: 'é',
                SourceOffset: 0,
                ChunkComplete: false,
                Truncated: false,
                SourceHash: '3:test',
                SourceLength: 3
            }],
            Next: { PathIndex: 1, SourceOffset: 2 },
            PlaceIdentity: TEST_PLACE_IDENTITY
        },
        {
            Records: [{
                Path: 'ServerScriptService.Unicode',
                Name: 'Unicode',
                ClassName: 'Script',
                SourceChunk: 'x',
                SourceOffset: 2,
                ChunkComplete: true,
                Truncated: false,
                SourceHash: '3:test',
                SourceLength: 3
            }],
            PlaceIdentity: TEST_PLACE_IDENTITY
        }
    ]);
    const records = await studioUtils.fetchScriptSources(
        communicator,
        ['ServerScriptService.Unicode'],
        { maxScripts: 1 }
    );
    assert.equal(records[0].Source, 'éx');
});

test('paged source retrieval can advance to a partially returned later script', async () => {
    const base = {
        ClassName: 'Script',
        Truncated: false,
        SourceHash: '6:test',
        SourceLength: 6
    };
    const communicator = communicatorSequence([
        {
            Records: [
                { ...base, Path: 'ServerScriptService.Small', Name: 'Small', SourceChunk: 'small!', SourceOffset: 0, ChunkComplete: true },
                { ...base, Path: 'ServerScriptService.Big', Name: 'Big', SourceChunk: 'abc', SourceOffset: 0, ChunkComplete: false }
            ],
            Next: { PathIndex: 2, SourceOffset: 3 },
            PlaceIdentity: TEST_PLACE_IDENTITY
        },
        {
            Records: [
                { ...base, Path: 'ServerScriptService.Big', Name: 'Big', SourceChunk: 'def', SourceOffset: 3, ChunkComplete: true }
            ],
            PlaceIdentity: TEST_PLACE_IDENTITY
        }
    ]);
    const records = await studioUtils.fetchScriptSources(
        communicator,
        ['ServerScriptService.Small', 'ServerScriptService.Big'],
        { maxScripts: 2 }
    );
    assert.deepEqual(records.map(record => record.Source), ['small!', 'abcdef']);
});

test('source retrieval aligns a truncated UTF-8 target before paging', async () => {
    let generatedCode = '';
    const communicator = {
        isAlive: () => true,
        callTool: async (_name, args) => {
            generatedCode = args.code;
            return {
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            Records: [],
                            PlaceIdentity: TEST_PLACE_IDENTITY
                        })
                    }]
                }
            };
        }
    };
    await studioUtils.fetchScriptSources(
        communicator,
        ['ServerScriptService.Unicode'],
        { maxScripts: 1, maxSourceLength: 2 }
    );
    assert.match(generatedCode, /while targetLength > 0 and utf8\.len/);
    assert.match(generatedCode, /targetLength -= 1/);
});

test('remote usage aggregation collapses exact duplicates but preserves distinct lines', () => {
    const index = remoteUtils.buildRemoteUsageIndex([{
        Name: 'Server',
        Path: 'ServerScriptService.Server',
        SourceHash: 'hash',
        RemoteUsage: [
            { Name: 'TradeEvent', Symbol: 'remote', Method: 'FireClient', Line: 10 },
            { Name: 'TradeEvent', Symbol: 'remote', Method: 'FireClient', Line: 10 },
            { Name: 'TradeEvent', Symbol: 'remote', Method: 'FireClient', Line: 20 }
        ]
    }], () => 'Server');
    const participants = remoteUtils.participantsForRemote(index, 'tradeevent');
    assert.equal(participants.length, 2);
    assert.equal(participants[0].Occurrences, 2);
    assert.equal(participants[1].Occurrences, 1);
});

test('source fingerprints use UTF-8 byte length', () => {
    assert.match(studioUtils.sourceFingerprint('é'), /^2:/);
});

test('unpublished place identities are bound by normalized game name', () => {
    assert.equal(brainStore.placeIdentitiesMatch(
        { Name: 'Local A', PlaceId: 0, GameId: 0 },
        { Name: 'local a', PlaceId: 0, GameId: 0 }
    ), true);
    assert.equal(brainStore.placeIdentitiesMatch(
        { Name: 'Local A', PlaceId: 0, GameId: 0 },
        { Name: 'Local B', PlaceId: 0, GameId: 0 }
    ), false);
});

test('project snapshot works from the indexed cache without Studio', async () => {
    const result = JSON.parse(await getProjectSnapshot.run({ include_live_place: false, limit: 2 }));
    assert.equal(result.Status, 'Snapshot Ready');
    assert.equal(result.Counts.TotalIndexedInstances, 5);
    assert.equal(result.Results.length, 2);
    assert.equal(result.Page.NextOffset, 2);
});

test('Studio targeting auto-selects one instance and rejects ambiguous sessions', () => {
    const response = value => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    assert.equal(studioUtils.selectStudioId(response({ studios: [{ id: 'one', name: 'Place' }] })), 'one');
    assert.throws(() => studioUtils.selectStudioId(response({
        studios: [{ id: 'one', name: 'A' }, { id: 'two', name: 'B' }]
    })), /provide studio_id/);
});

test('related-code compact mode obeys result and character budgets', async () => {
    const text = await getRelatedCode.run({
        task: 'trade',
        detail: 'compact',
        max_results: 1,
        max_chars: 2_000
    });
    const result = JSON.parse(text);
    assert.ok(text.length <= 2_000);
    assert.equal(result.RelevantFiles.length, 1);
    assert.equal(result.RelevantFiles[0].Requires, undefined);
});

test('symbol index resolves definitions and callers with line evidence', async () => {
    const definition = JSON.parse(await findSymbol.run({
        symbol: 'TradeService:AcceptOffer',
        mode: 'definition'
    }));
    assert.equal(definition.Definitions[0].Line, 10);

    const callers = JSON.parse(await findSymbol.run({ symbol: 'AcceptOffer', mode: 'callers' }));
    assert.deepEqual(callers.Callers[0].Lines, [20]);
});

test('project history snapshots, journals, and summarizes structural diffs', async () => {
    const saved = JSON.parse(await projectHistory.saveSnapshot({ label: 'start-of-day', version: 'alpha v1.0.0' }));
    await projectHistory.recordChange({ change: 'Changed barking to woofing.', importance: 'important' });
    const unchanged = JSON.parse(await projectHistory.diffProject({ snapshot_id: saved.SnapshotId }));
    assert.equal(unchanged.Summary.Changed, 0);
    assert.equal(unchanged.RecordedChanges[0].Importance, 'important');

    const structural = projectHistory.compareProjectItems(
        [
            { Path: 'A.Old', Class: 'ModuleScript', SourceHash: 'same', SourceLines: 10 },
            { Path: 'A.Live', Class: 'Script', SourceHash: 'old', SourceLines: 5, Functions: ['Old'] }
        ],
        [
            { Path: 'A.New', Class: 'ModuleScript', SourceHash: 'same', SourceLines: 10 },
            { Path: 'A.Live', Class: 'Script', SourceHash: 'new', SourceLines: 8, Functions: ['New'] }
        ]
    );
    assert.equal(structural.Summary.Moved, 1);
    assert.equal(structural.Summary.Changed, 1);
    assert.equal(structural.Summary.LinesAdded, 3);
});

test('private source diff returns only numbered changed lines', () => {
    const result = projectHistory.createSourceDiff(
        'ServerScriptService.PlotManager',
        ['local value = 1', 'oldCall()', 'return value'].join('\n'),
        ['local value = 1', 'newCall()', 'extraCall()', 'return value'].join('\n')
    );
    assert.equal(result.LinesAdded, 2);
    assert.equal(result.LinesRemoved, 1);
    assert.deepEqual(result.Hunks.flatMap(hunk => hunk.Lines), [
        '-2 oldCall()',
        '+2 newCall()',
        '+3 extraCall()'
    ]);
    assert.equal(JSON.stringify(result).includes('local value = 1'), false);
    assert.equal(JSON.stringify(result).includes('return value'), false);
});

test('changing the visual version rotates only after a complete private source capture', async () => {
    const sourceRecords = [
        ['ReplicatedStorage.Trade.TradeConfig', 'TradeConfig', 'ModuleScript'],
        ['ServerScriptService.Services.TradeService', 'TradeService', 'ModuleScript'],
        ['StarterPlayer.StarterPlayerScripts.TradingClient', 'TradingClient', 'ModuleScript'],
        ['StarterGui.Main.Trading.TradeMenu', 'TradeMenu', 'LocalScript']
    ].map(([Path, Name, ClassName]) => ({
        Path,
        Name,
        ClassName,
        Source: 'return {}',
        SourceHash: '9:test',
        SourceLength: 9
    }));
    const first = JSON.parse(await projectHistory.saveSnapshot(
        { label: 'first', version: 'alpha v1.0.0', refresh: false },
        communicatorReturning(sourceRecords)
    ));
    const second = JSON.parse(await projectHistory.saveSnapshot(
        { label: 'second', version: 'alpha v1.0.1', refresh: false },
        communicatorReturning(sourceRecords)
    ));
    assert.equal(first.SourceBaseline.Captured, true);
    assert.equal(first.SourceBaseline.Complete, true);
    assert.equal(second.SourceBaseline.Captured, true);
    assert.equal(second.SourceBaseline.Complete, true);
    assert.deepEqual(fs.readdirSync(sourceCacheDirectory), [`${second.SnapshotId}.json`]);

    const incomplete = JSON.parse(await projectHistory.saveSnapshot(
        { label: 'incomplete', version: 'beta v1.0.0', refresh: false },
        communicatorReturning(sourceRecords.slice(0, 1))
    ));
    assert.equal(incomplete.SourceBaseline.Complete, false);
    assert.deepEqual(fs.readdirSync(sourceCacheDirectory).sort(), [
        `${second.SnapshotId}.json`,
        `${incomplete.SnapshotId}.json`
    ].sort());
});

test('lifecycle graph maps visible disconnect and cancellation ownership', () => {
    const graph = auditLifecycle.buildLifecycleGraph({
        Path: 'ServerScriptService.PlotManager',
        Source: [
            'local connection = Players.PlayerAdded:Connect(onPlayer)',
            'local updateThread = task.spawn(UpdatePlots)',
            'connection:Disconnect()',
            'task.cancel(updateThread)',
            'RunService.Heartbeat:Connect(render)'
        ].join('\n')
    });
    assert.equal(graph.Summary.OwnedConnections, 1);
    assert.equal(graph.Summary.UnownedConnections, 1);
    assert.equal(graph.Summary.CancelledTasks, 1);
});

test('instance inspection parses bounded live Studio evidence', async () => {
    const result = JSON.parse(await inspectInstance.run(
        { path: 'ReplicatedStorage.Remotes.TradeEvent' },
        communicatorReturning([{ Path: 'ReplicatedStorage.Remotes.TradeEvent', Found: true }])
    ));
    assert.equal(result.Instances[0].Found, true);
    assert.equal(result.Evidence, 'live-studio');
});

test('script context combines live source and indexed relationships', async () => {
    const source = '--!strict\nreturn {}';
    const result = JSON.parse(await readScriptContext.run(
        { path: 'ServerScriptService.Services.TradeService', line_count: 10 },
        communicatorReturning([{
            Path: 'ServerScriptService.Services.TradeService',
            Name: 'TradeService',
            ClassName: 'ModuleScript',
            Source: source,
            SourceHash: studioUtils.sourceFingerprint(source),
            SourceLength: source.length
        }])
    ));
    assert.match(result.Source.NumberedText, /1: --!strict/);
    assert.deepEqual(result.Relationships.DirectDependencies.map(item => item.Name), ['TradeConfig']);
});

test('live source search returns line-numbered matches', async () => {
    const result = JSON.parse(await searchSource.run(
        { query: 'RequestTrade' },
        communicatorReturning({
            Matches: [{ Path: 'A.B', Line: 4, Snippet: '4: RequestTrade' }],
            Returned: 1,
            ObservedMatches: 1,
            ScannedScripts: 3,
            NextOffset: null,
            PatternError: null
        })
    ));
    assert.equal(result.Matches[0].Line, 4);
    assert.equal(result.Evidence, 'live-source');
});

test('script patch dry-run returns precondition preview without a transaction', async () => {
    const result = JSON.parse(await applyScriptPatch.run(
        {
            path: 'ServerScriptService.Services.TradeService',
            edits: [{ old_text: 'old', new_text: 'new', expected_count: 1 }],
            dry_run: true
        },
        communicatorReturning({
            Status: 'Dry Run',
            Changes: [{ Path: 'ServerScriptService.Services.TradeService', BeforeHash: '3:1', AfterHash: '3:2' }]
        })
    ));
    assert.equal(result.Status, 'Dry Run');
    assert.equal(fs.readdirSync(transactionDirectory).length, 0);
});

test('live script patches require both idempotency and source-hash preconditions', async () => {
    const noIdempotency = JSON.parse(await applyScriptPatch.run({
        path: 'ServerScriptService.Services.TradeService',
        expected_source_hash: 'hash',
        edits: [{ old_text: 'old', new_text: 'new' }]
    }, communicatorReturning({})));
    assert.match(noIdempotency.error, /idempotency_key/);

    const noHash = JSON.parse(await applyScriptPatch.run({
        path: 'ServerScriptService.Services.TradeService',
        edits: [{ old_text: 'old', new_text: 'new' }],
        idempotency_key: 'missing-hash'
    }, communicatorReturning({})));
    assert.match(noHash.error, /expected_source_hash/);
});

test('atomic patches reject duplicate script paths', async () => {
    const result = JSON.parse(await applyScriptPatch.run({
        changes: [
            { path: 'ServerScriptService.A', edits: [{ old_text: 'a', new_text: 'b' }] },
            { path: 'ServerScriptService.A', edits: [{ old_text: 'b', new_text: 'c' }] }
        ],
        dry_run: true
    }));
    assert.match(result.error, /only once/);
});

test('architecture tool reports unchanged manifests without recording a transaction', async () => {
    const result = JSON.parse(await createArchitecture.run(
        {
            nodes: [{
                path: 'ReplicatedStorage.Remotes',
                class_name: 'Folder'
            }],
            idempotency_key: 'unchanged-architecture'
        },
        communicatorReturning({ Status: 'Unchanged', Changes: [] })
    ));
    assert.equal(result.Status, 'Unchanged');
    assert.equal(fs.readdirSync(transactionDirectory).length, 0);
});

test('architecture manifests cannot overwrite the rollback identity marker', async () => {
    const result = JSON.parse(await createArchitecture.run({
        nodes: [{
            path: 'ReplicatedStorage.System',
            class_name: 'Folder',
            attributes: { _SuperMCPTransactionId: 'spoofed' }
        }],
        dry_run: true
    }));
    assert.match(result.error, /reserved/);
});

test('remote contract audit identifies missing runtime validation in live participant source', async () => {
    const result = JSON.parse(await validateRemoteContract.run(
        { remote_name: 'TradeEvent' },
        communicatorReturning([
            {
                Path: 'ServerScriptService.Services.TradeService',
                Source: 'tradeRemote.OnServerEvent:Connect(function(player, payload)\nprint(payload)\nend)',
                SourceHash: 'x'
            },
            {
                Path: 'StarterPlayer.StarterPlayerScripts.TradingClient',
                Source: 'tradeRemote:FireServer("accept")',
                SourceHash: 'y'
            }
        ])
    ));
    assert.ok(result.Findings.some(item => item.Rule === 'runtime-payload-validation'));
});

test('remote contract audit refuses endpoint findings from stale indexed source', async () => {
    const result = JSON.parse(await validateRemoteContract.run(
        { remote_name: 'TradeEvent' },
        communicatorReturning([{
            Path: 'ServerScriptService.Services.TradeService',
            Source: 'tradeRemote.OnServerEvent:Connect(function(player, payload)\nprint(payload)\nend)',
            SourceHash: 'changed-after-index'
        }])
    ));
    assert.equal(result.Status, 'INCOMPLETE');
    assert.deepEqual(result.HashMismatchPaths, ['ServerScriptService.Services.TradeService']);
    assert.ok(!result.Findings.some(item => item.Rule === 'runtime-payload-validation'));
});

test('lifecycle audit finds unowned connections and unbounded waits', async () => {
    const result = JSON.parse(await auditLifecycle.run(
        {},
        communicatorReturning([{
            Path: 'ServerScriptService.Services.TradeService',
            Source: 'workspace:WaitForChild("Thing")\nworkspace.ChildAdded:Connect(function() end)',
            SourceHash: 'x'
        }])
    ));
    assert.ok(result.Findings.some(item => item.Rule === 'unowned-connections'));
    assert.ok(result.Findings.some(item => item.Rule === 'unbounded-wait-for-child'));
});

test('audits are incomplete offline and ignore forbidden text in comments', async () => {
    const offline = JSON.parse(await auditLifecycle.run({}));
    assert.equal(offline.Status, 'INCOMPLETE');

    const commented = JSON.parse(await auditLifecycle.run(
        {},
        communicatorReturning([{
            Path: 'ServerScriptService.Services.TradeService',
            Source: '-- workspace:WaitForChild("Thing")\n-- signal:Connect(function() end)',
            SourceHash: 'x'
        }])
    ));
    assert.equal(commented.Findings.some(item =>
        ['unbounded-wait-for-child', 'unowned-connections'].includes(item.Rule)
    ), false);
});

test('performance audit finds allocations inside frame callbacks', async () => {
    const result = JSON.parse(await auditPerformance.run(
        {},
        communicatorReturning([{
            Path: 'StarterPlayer.StarterPlayerScripts.TradingClient',
            Source: 'RunService.RenderStepped:Connect(function()\nlocal part = Instance.new("Part")\nend)',
            SourceHash: 'x'
        }])
    ));
    assert.ok(result.Findings.some(item => item.Rule === 'hot-instance-allocation'));
});

test('data-integrity audit rejects SetAsync', async () => {
    const result = JSON.parse(await auditDataIntegrity.run(
        {},
        communicatorReturning([{
            Path: 'ServerScriptService.Services.TradeService',
            Source: 'store:SetAsync(player.UserId, data)',
            SourceHash: 'x'
        }])
    ));
    assert.ok(result.Findings.some(item => item.Rule === 'set-async' && item.Severity === 'Critical'));
});

test('race audit reports multiple anchoring authorities', async () => {
    const result = JSON.parse(await detectRaceConditions.run(
        {},
        communicatorReturning([
            { Path: 'ServerScriptService.Services.TradeService', Source: 'root.Anchored = true', SourceHash: 'a' },
            { Path: 'StarterPlayer.StarterPlayerScripts.TradingClient', Source: 'root.Anchored = false', SourceHash: 'b' }
        ])
    ));
    assert.ok(result.Findings.some(item => item.Rule === 'multiple-anchor-authorities'));
});

test('dead-code analysis labels candidates instead of authorizing deletion', async () => {
    const result = JSON.parse(await findDeadCode.run({}));
    assert.match(result.ConfidencePolicy, /never automatic deletion/);
    assert.ok(result.Candidates.some(item => item.Kind === 'Remote') === false);
});

test('change plan is deterministic for the same indexed request', async () => {
    const first = JSON.parse(await generateChangePlan.run({ request: 'change trade acceptance' }));
    const second = JSON.parse(await generateChangePlan.run({ request: 'change trade acceptance' }));
    assert.equal(first.PlanId, second.PlanId);
    assert.equal(first.NonMutating, true);
    assert.ok(first.Phases.some(phase => phase.Mutation));
});

test('transaction store supports idempotency lookups and public redaction', () => {
    const transaction = transactionStore.createTransaction({
        tool: 'apply_script_patch',
        idempotencyKey: 'stable-key',
        changes: [{
            Kind: 'ScriptSource',
            Path: 'ServerScriptService.Secret',
            BeforeSource: 'secret-before',
            AfterSource: 'secret-after'
        }]
    });
    const found = transactionStore.findTransactionByIdempotencyKey('stable-key', 'apply_script_patch');
    assert.equal(found.TransactionId, transaction.TransactionId);
    const publicValue = transactionStore.publicTransaction(found);
    assert.equal('Changes' in publicValue, false);
});

test('transaction lifecycle applies, verifies, and rolls back a script patch', async () => {
    const pathValue = 'ServerScriptService.Services.TradeService';
    const beforeSource = '--!strict\nreturn "before"';
    const afterSource = '--!strict\nreturn "after"';
    const beforeHash = studioUtils.sourceFingerprint(beforeSource);
    const afterHash = studioUtils.sourceFingerprint(afterSource);
    const applied = JSON.parse(await applyScriptPatch.run({
        path: pathValue,
        expected_source_hash: beforeHash,
        edits: [{ old_text: '"before"', new_text: '"after"', expected_count: 1 }],
        idempotency_key: 'transaction-lifecycle'
    }, communicatorSequence([
        {
            Records: [{
                Path: pathValue,
                Name: 'TradeService',
                ClassName: 'ModuleScript',
                Source: beforeSource,
                Truncated: false,
                SourceHash: beforeHash,
                SourceLength: beforeSource.length
            }],
            PlaceIdentity: TEST_PLACE_IDENTITY
        },
        {
            Status: 'Applied',
            SyntaxValidation: 'passed',
            Changes: [{
                Kind: 'ScriptSource',
                Path: pathValue,
                BeforeSource: beforeSource,
                AfterSource: afterSource,
                BeforeHash: beforeHash,
                AfterHash: afterHash,
                BeforeLength: beforeSource.length,
                AfterLength: afterSource.length,
                EditResults: [{ EditIndex: 1, Replacements: 1 }]
            }]
        }
    ])));
    assert.equal(applied.Status, 'Applied and State Verified');

    const transactionId = applied.Transaction.TransactionId;
    const conflict = JSON.parse(await applyScriptPatch.run({
        path: pathValue,
        expected_source_hash: afterHash,
        edits: [{ old_text: '"after"', new_text: '"different"', expected_count: 1 }],
        idempotency_key: 'transaction-lifecycle'
    }, communicatorReturning({})));
    assert.equal(conflict.Status, 'Idempotency Conflict');

    const verified = JSON.parse(await verifyChange.run(
        { transaction_id: transactionId },
        communicatorSequence([
            TEST_PLACE_IDENTITY,
            [{
                Index: 1,
                Kind: 'ScriptSource',
                Path: pathValue,
                Exists: true,
                ObservedHash: afterHash,
                ExpectedHash: afterHash,
                Source: afterSource
            }]
        ])
    ));
    assert.equal(verified.Status, 'VERIFIED');

    const rolledBack = JSON.parse(await rollbackChange.run(
        { transaction_id: transactionId },
        communicatorSequence([
            TEST_PLACE_IDENTITY,
            {
                Status: 'Rolled Back',
                Applied: [{ Kind: 'ScriptSource', Path: pathValue }],
                Verification: [{ Kind: 'ScriptSource', Path: pathValue, Passed: true }]
            }
        ])
    ));
    assert.equal(rolledBack.Status, 'Rolled Back');
    assert.equal(transactionStore.loadTransaction(transactionId).transaction.Status, 'RolledBack');
});

test('verify_change reconciles an uncertain transaction that was never applied', async () => {
    const pathValue = 'ServerScriptService.Services.TradeService';
    const prepared = transactionStore.prepareTransaction({
        tool: 'apply_script_patch',
        idempotencyKey: 'never-applied',
        changes: [{
            Kind: 'ScriptSource',
            Path: pathValue,
            BeforeSource: 'before',
            AfterSource: 'after',
            BeforeHash: '6:before',
            AfterHash: '5:after'
        }],
        metadata: { PlaceIdentity: TEST_PLACE_IDENTITY }
    });
    transactionStore.finalizeTransaction(prepared, { status: 'Uncertain' });
    const result = JSON.parse(await verifyChange.run(
        { transaction_id: prepared.TransactionId },
        communicatorSequence([
            TEST_PLACE_IDENTITY,
            [{
                Index: 1,
                Kind: 'ScriptSource',
                Path: pathValue,
                Exists: true,
                ObservedHash: '6:before',
                ExpectedHash: '5:after',
                Source: 'before'
            }]
        ])
    ));
    assert.equal(result.Status, 'NOT APPLIED');
    assert.equal(result.Checks[0].State, 'BEFORE');
    assert.equal(transactionStore.loadTransaction(prepared.TransactionId).transaction.Status, 'Aborted');
});
