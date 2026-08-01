import { cacheMetadata, loadBrain } from './brain_store.js';
import { buildDependencyGraph, findBestTarget, findCycles, walkGraph } from './graph_utils.js';
import { clampInteger } from './studio_utils.js';

export async function run(args) {
    const query = String(args.change || args.target_script || '').trim();
    if (!query) return JSON.stringify({ error: 'Please specify the script or component you plan to modify.' });

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);

    const target = findBestTarget(loaded.brain.AllItems, query);
    if (!target) return JSON.stringify({ error: `No component matching '${query}' was found.` }, null, 2);

    const graph = buildDependencyGraph(loaded.brain.AllItems);
    const maxDepth = clampInteger(args.max_depth, 6, 1, 12);
    const direct = graph.dependents.get(target.item.Path) || [];
    const transitive = walkGraph(target.item.Path, graph.dependents, maxDepth)
        .filter(result => result.depth > 1);
    const remoteNames = new Set((target.item.RemoteUsage || []).map(record => record.Name.toLowerCase()));
    const remotePeers = loaded.brain.AllItems.filter(item =>
        item.Path !== target.item.Path &&
        (item.RemoteUsage || []).some(record => remoteNames.has(record.Name.toLowerCase()))
    );
    const attributeNames = new Set((target.item.Attributes || []).map(name => name.toLowerCase()));
    const attributePeers = loaded.brain.AllItems.filter(item =>
        item.Path !== target.item.Path &&
        (item.Attributes || []).some(name => attributeNames.has(name.toLowerCase()))
    );
    const cycles = findCycles(target.item.Path, graph.dependencies, maxDepth);

    const persistence = target.item.ServicesUsed.includes('DataStoreService') || target.item.DataStoreUsage.length > 0;
    const networking = target.item.RemoteUsage.length > 0 || remotePeers.length > 0;
    let riskScore = direct.length * 3 + transitive.length + remotePeers.length * 2;
    if (persistence) riskScore += 8;
    if (networking) riskScore += 5;
    if (target.item.Category === 'ReplicatedStorage') riskScore += 2;
    riskScore += Math.min(6, attributePeers.length);
    if (cycles.length > 0) riskScore += 5;

    const level = riskScore >= 15 ? 'HIGH' : riskScore >= 6 ? 'MEDIUM' : 'LOW';
    const reasons = [];
    if (direct.length) reasons.push(`${direct.length} direct dependent(s)`);
    if (transitive.length) reasons.push(`${transitive.length} transitive dependent(s)`);
    if (remotePeers.length) reasons.push(`${remotePeers.length} component(s) share remote symbols`);
    if (persistence) reasons.push('touches persistence APIs');
    if (networking) reasons.push('participates in network traffic');
    if (attributePeers.length) reasons.push(`${attributePeers.length} component(s) share attribute names`);
    if (cycles.length) reasons.push(`${cycles.length} dependency cycle(s) detected`);
    if (!reasons.length) reasons.push('no indexed downstream coupling detected');

    return JSON.stringify({
        ProposedChange: query,
        Target: summarize(target.item),
        MatchConfidence: target.confidence,
        Alternatives: target.alternatives,
        RiskAssessment: {
            Level: level,
            Score: riskScore,
            Reasons: reasons,
            Recommendation: recommendation(level, persistence, networking)
        },
        AffectedSystems: {
            DirectDependents: direct.slice(0, 500).map(summarize),
            TransitiveDependents: transitive.slice(0, 500).map(({ item, depth }) => ({ ...summarize(item), Depth: depth })),
            SharedRemoteParticipants: remotePeers.slice(0, 500).map(summarize),
            SharedAttributeParticipants: attributePeers.slice(0, 500).map(summarize),
            DependencyCycles: cycles
        },
        MaxDepth: maxDepth,
        ResultBounds: {
            PerRelationshipLimit: 500,
            AnyRelationshipTruncated: [direct, transitive, remotePeers, attributePeers].some(items => items.length > 500)
        },
        EvidenceAvailable: target.item.SourceReadable === true,
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }, null, 2);
}

function recommendation(level, persistence, networking) {
    if (level === 'HIGH') return 'Review all dependents and run integration tests before changing this component.';
    if (persistence || networking) return 'Test persistence and remote validation paths before release.';
    return 'Use targeted tests for the component and its direct dependents.';
}

function summarize(item) {
    return { Name: item.Name, ClassName: item.Class, Path: item.Path, Category: item.Category };
}
