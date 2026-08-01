import { cacheMetadata, loadBrain } from './brain_store.js';
import { buildDependencyGraph, findBestTarget, findCycles, walkGraph } from './graph_utils.js';
import { clampInteger } from './studio_utils.js';

export async function run(args) {
    const query = String(args.script_name || '').trim();
    if (!query) return JSON.stringify({ error: 'Please provide a valid script_name.' });

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);

    const target = findBestTarget(loaded.brain.AllItems, query);
    if (!target) {
        return JSON.stringify({ error: `No script matching '${query}' was found.`, Cache: cacheMetadata(loaded.brain, loaded.staleSchema) }, null, 2);
    }

    const graph = buildDependencyGraph(loaded.brain.AllItems);
    const maxDepth = clampInteger(args.max_depth, 6, 1, 12);
    const directDependencies = graph.dependencies.get(target.item.Path) || [];
    const directDependents = graph.dependents.get(target.item.Path) || [];
    const transitiveDependencies = walkGraph(target.item.Path, graph.dependencies, maxDepth);
    const transitiveDependents = walkGraph(target.item.Path, graph.dependents, maxDepth);

    return JSON.stringify({
        Query: query,
        Target: summarize(target.item),
        MatchConfidence: target.confidence,
        Alternatives: target.alternatives,
        DirectDependencies: directDependencies.map(summarize),
        DirectDependents: directDependents.map(summarize),
        TransitiveDependencies: transitiveDependencies.slice(0, 500).map(({ item, depth }) => ({ ...summarize(item), Depth: depth })),
        TransitiveDependents: transitiveDependents.slice(0, 500).map(({ item, depth }) => ({ ...summarize(item), Depth: depth })),
        Cycles: findCycles(target.item.Path, graph.dependencies, maxDepth),
        MaxDepth: maxDepth,
        ResultBounds: {
            TransitiveLimit: 500,
            DependenciesTruncated: transitiveDependencies.length > 500,
            DependentsTruncated: transitiveDependents.length > 500
        },
        AmbiguousRequirements: graph.ambiguous.get(target.item.Path) || [],
        UnresolvedRequirements: graph.unresolved.get(target.item.Path) || [],
        ServicesUsed: target.item.ServicesUsed,
        EvidenceAvailable: target.item.SourceReadable === true,
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }, null, 2);
}

function summarize(item) {
    return { Name: item.Name, ClassName: item.Class, Path: item.Path, Category: item.Category };
}
