import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.ROBLOX_SUPER_MCP_BRAIN_PATH = path.join(__dirname, 'fixture_brain.json');

const findDependencies = await import('../tools/find_dependencies.js');
const findSystem = await import('../tools/find_system.js');
const getRemoteRegistry = await import('../tools/get_remote_registry.js');
const graphUtils = await import('../tools/graph_utils.js');
const impactAnalysis = await import('../tools/impact_analysis.js');
const analyzeProject = await import('../tools/analyze_project.js');
const sanityCheck = await import('../tools/sanity_check_script.js');
const traceDataFlow = await import('../tools/trace_data_flow.js');

test('live scan parser unwraps native JSON-RPC tool envelopes', () => {
    const items = analyzeProject.parseStudioItems({
        jsonrpc: '2.0',
        id: 7,
        result: {
            content: [{ type: 'text', text: '[{"Name":"TradeService"}]' }]
        }
    });
    assert.equal(items[0].Name, 'TradeService');
});

test('scanner builds bounded category pages without unresolved placeholders', () => {
    const code = analyzeProject.buildScannerScript('ReplicatedStorage', 30, [{
        Path: 'ReplicatedStorage.TradeConfig',
        Class: 'ModuleScript',
        SourceHash: '10:abc'
    }]);
    assert.ok(code.includes('local SCAN_CATEGORY = "ReplicatedStorage"'));
    assert.ok(code.includes('local SCAN_OFFSET = 30'));
    assert.ok(code.includes('local SCAN_LIMIT = 150'));
    assert.ok(code.includes('local MAX_PAGE_BYTES = 70000'));
    assert.ok(code.includes('HttpService:JSONEncode(item)'));
    assert.ok(code.includes('known.SourceHash == sourceFingerprint(source)'));
    assert.ok(code.includes('ReplicatedStorage.TradeConfig'));
    assert.equal(code.includes('__SCAN_'), false);
});

test('live scan parser accepts paginated Studio responses', () => {
    const chunk = analyzeProject.parseStudioChunk({
        result: {
            content: [{
                type: 'text',
                text: '{"Items":[{"Name":"TradeEvent"}],"NextOffset":30}'
            }]
        }
    });
    assert.equal(chunk.Items[0].Name, 'TradeEvent');
    assert.equal(chunk.NextOffset, 30);
});

test('live scan parser exposes oversized metadata evidence', () => {
    const chunk = analyzeProject.parseStudioChunk({
        result: {
            content: [{
                type: 'text',
                text: '{"Items":[],"NextOffset":null,"OversizedItems":["ServerScriptService.Huge"]}'
            }]
        }
    });
    assert.deepEqual(chunk.OversizedItems, ['ServerScriptService.Huge']);
});

test('dependency tool resolves direct and transitive graph directions', async () => {
    const config = JSON.parse(await findDependencies.run({ script_name: 'TradeConfig' }));
    assert.deepEqual(config.DirectDependents.map(item => item.Name), ['TradeService']);
    assert.deepEqual(config.TransitiveDependents.map(item => item.Name), ['TradeService', 'TradingClient', 'TradeMenu']);
});

test('dependency graph does not fabricate edges for duplicate module names', () => {
    const graph = graphUtils.buildDependencyGraph([
        { Name: 'Consumer', Class: 'Script', Path: 'ServerScriptService.Consumer', Requires: ['Config'] },
        { Name: 'Config', Class: 'ModuleScript', Path: 'ReplicatedStorage.A.Config', Requires: [] },
        { Name: 'Config', Class: 'ModuleScript', Path: 'ReplicatedStorage.B.Config', Requires: [] }
    ]);
    assert.deepEqual(graph.dependencies.get('ServerScriptService.Consumer'), []);
    assert.equal(graph.ambiguous.get('ServerScriptService.Consumer')[0].CandidatePaths.length, 2);
});

test('system discovery normalizes trading word forms and explains matches', async () => {
    const result = JSON.parse(await findSystem.run({ system_name: 'systems with trading' }));
    assert.equal(result.SearchTokens[0], 'trade');
    assert.equal(result.TotalMatches, 5);
    assert.ok(result.ServerServices[0].MatchReason);
});

test('impact analysis detects persistence, networking, and transitive users', async () => {
    const result = JSON.parse(await impactAnalysis.run({ change: 'TradeService' }));
    assert.equal(result.RiskAssessment.Level, 'HIGH');
    assert.ok(result.RiskAssessment.Reasons.includes('touches persistence APIs'));
    assert.equal(result.AffectedSystems.TransitiveDependents[0].Name, 'TradeMenu');
});

test('remote registry links observed clients and server listeners', async () => {
    const result = JSON.parse(await getRemoteRegistry.run({}));
    const endpoint = result.RemoteEndpoints[0];
    assert.equal(endpoint.Name, 'TradeEvent');
    assert.deepEqual(endpoint.MethodsObserved, ['FireClient', 'FireServer', 'OnClientEvent', 'OnServerEvent']);
    assert.deepEqual(endpoint.Findings, []);
});

test('data flow reports only observed stages and persistence evidence', async () => {
    const result = JSON.parse(await traceDataFlow.run({ variable_name: 'trade' }));
    assert.equal(result.TraceStatus, 'Observed participants found');
    assert.ok(result.ObservedRemoteActivity.some(stage => stage.Stage === 'Client Intent'));
    assert.ok(result.ObservedRemoteActivity.some(stage => stage.Stage === 'Server Receiver'));
    assert.ok(result.PersistenceEvidence.some(stage => stage.DataStore === 'PlayerTrades'));
    assert.ok(result.Limitations.some(message => message.includes('not a proven causal')));
});

test('sanity audit is line-aware and ignores forbidden words in comments', async () => {
    const source = `--!strict
-- wait() is mentioned only in documentation
local child = workspace:WaitForChild("Thing")
remote.OnServerEvent:Connect(function(player, value)
    print(value)
end)
`;
    const result = JSON.parse(await sanityCheck.run({ script_name: 'Unsafe', script_content: source }));
    assert.equal(result.Findings.some(item => item.Rule === 'deprecated-wait'), false);
    assert.equal(result.Findings.find(item => item.Rule === 'unbounded-wait-for-child').Line, 3);
    assert.ok(result.Findings.some(item => item.Rule === 'remote-runtime-validation'));
    assert.ok(result.Findings.some(item => item.Rule === 'connection-lifecycle'));
});
