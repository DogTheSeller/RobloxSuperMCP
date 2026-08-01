import { cacheMetadata, loadBrain } from './brain_store.js';
import { buildDependencyGraph, findBestTarget, walkGraph } from './graph_utils.js';
import { clampInteger, fetchScriptSources, summarizeItem } from './studio_utils.js';

export async function run(args = {}, studioCommunicator) {
    const query = String(args.path || args.script_name || '').trim();
    if (!query) return JSON.stringify({ error: 'Provide an exact script path or script_name.' });

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const scripts = loaded.brain.AllItems.filter(item => item.Class.endsWith('Script'));
    const target = findBestTarget(scripts, query);
    if (!target) return JSON.stringify({ error: `No indexed script matching '${query}' was found.` }, null, 2);

    const sources = await fetchScriptSources(studioCommunicator, [target.item.Path], {
        maxScripts: 1,
        maxSourceLength: 1_000_000,
        maxTotalSourceLength: 1_000_000
    });
    const sourceRecord = sources[0];
    if (!sourceRecord) {
        return JSON.stringify({
            error: `The source for '${target.item.Path}' could not be read from Studio.`,
            Target: summarizeItem(target.item),
            Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
        }, null, 2);
    }

    const lines = sourceRecord.Source.split(/\r?\n/);
    const startLine = clampInteger(args.start_line, 1, 1, Math.max(1, lines.length));
    const lineCount = clampInteger(args.line_count, 200, 1, 500);
    const selectedLines = lines.slice(startLine - 1, startLine - 1 + lineCount);
    const graph = buildDependencyGraph(loaded.brain.AllItems);
    const dependencies = graph.dependencies.get(target.item.Path) || [];
    const dependents = graph.dependents.get(target.item.Path) || [];
    const transitiveDependents = walkGraph(target.item.Path, graph.dependents);

    return JSON.stringify({
        Target: summarizeItem(target.item),
        MatchConfidence: target.confidence,
        Alternatives: target.alternatives,
        Source: {
            Hash: sourceRecord.SourceHash,
            Length: sourceRecord.SourceLength,
            TotalLines: target.item.SourceLines || (sourceRecord.Truncated ? null : lines.length),
            ReadLines: lines.length,
            SourceTruncated: sourceRecord.Truncated === true,
            StartLine: startLine,
            EndLine: startLine + selectedLines.length - 1,
            Truncated: sourceRecord.Truncated === true ||
                startLine - 1 + selectedLines.length < lines.length,
            NumberedText: selectedLines
                .map((line, index) => `${startLine + index}: ${line}`)
                .join('\n')
        },
        Relationships: {
            DirectDependencies: dependencies.slice(0, 200).map(summarizeItem),
            DirectDependents: dependents.slice(0, 200).map(summarizeItem),
            TransitiveDependents: transitiveDependents.slice(0, 300).map(({ item, depth }) => ({
                ...summarizeItem(item),
                Depth: depth
            })),
            AmbiguousRequirements: (graph.ambiguous.get(target.item.Path) || []).slice(0, 100),
            UnresolvedRequirements: (graph.unresolved.get(target.item.Path) || []).slice(0, 100),
            Remotes: target.item.RemoteUsage.slice(0, 200),
            Services: target.item.ServicesUsed.slice(0, 100),
            Functions: target.item.Functions.slice(0, 200),
            Attributes: target.item.Attributes.slice(0, 200),
            Counts: {
                DirectDependencies: dependencies.length,
                DirectDependents: dependents.length,
                TransitiveDependents: transitiveDependents.length,
                Remotes: target.item.RemoteUsage.length,
                Services: target.item.ServicesUsed.length,
                Functions: target.item.Functions.length,
                Attributes: target.item.Attributes.length
            },
            CollectionLimits: {
                Direct: 200,
                Transitive: 300,
                Metadata: 200
            }
        },
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema),
        Evidence: 'live-source + indexed-relationships'
    }, null, 2);
}
