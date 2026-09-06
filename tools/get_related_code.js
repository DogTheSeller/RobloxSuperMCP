import { cacheMetadata, loadBrain } from './brain_store.js';
import { buildDependencyGraph } from './graph_utils.js';
import { findRankedItems, matchEvidence, tokenize } from './search_utils.js';
import {
    normalizeOutputOptions,
    normalizePagination,
    stringifyBounded,
    summarizeItem
} from './studio_utils.js';

export async function run(args) {
    const task = String(args.task || '').trim();
    const keywords = tokenize(task);
    if (!task || keywords.length === 0) return JSON.stringify({ error: 'Please provide a specific task description.' });

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error, KeywordsExtracted: keywords }, null, 2);

    const categories = Array.isArray(args.categories) ? new Set(args.categories.map(String)) : null;
    const ranked = findRankedItems(loaded.brain.AllItems, task, 500)
        .filter(({ item }) => !categories || categories.has(item.Category));
    const output = normalizeOutputOptions(args, { maxResults: 100 });
    const { offset, limit } = normalizePagination({ ...args, limit: output.maxResults }, {
        defaultLimit: output.maxResults,
        maxLimit: 100
    });
    const graph = buildDependencyGraph(loaded.brain.AllItems);
    const collectionLimit = output.detail === 'deep' ? 100 : 20;
    const includeDependencies = args.include_dependencies ?? output.detail !== 'compact';
    const includeRemotes = args.include_remotes ?? output.detail !== 'compact';
    const matches = ranked.slice(offset, offset + limit).map(({ item, match }) => ({
        RelevanceScore: match.score,
        MatchedTerms: match.matchedTokens,
        MatchEvidence: matchEvidence(item, task),
        Name: item.Name,
        ClassName: item.Class,
        Path: item.Path,
        Category: item.Category,
        RelevantFunctions: item.Functions.filter(name =>
            keywords.some(keyword => name.toLowerCase().includes(keyword))
        ),
        ...(output.detail === 'compact' ? {} : {
            Requires: item.Requires.slice(0, collectionLimit),
            ServicesUsed: item.ServicesUsed.slice(0, collectionLimit)
        }),
        ...(includeRemotes ? { RemoteUsage: item.RemoteUsage.slice(0, collectionLimit) } : {}),
        ...(includeDependencies ? {
            DirectDependencies: (graph.dependencies.get(item.Path) || []).slice(0, collectionLimit).map(summarizeItem),
            DirectDependents: (graph.dependents.get(item.Path) || []).slice(0, collectionLimit).map(summarizeItem)
        } : {}),
        CollectionCounts: {
            Requires: item.Requires.length,
            ServicesUsed: item.ServicesUsed.length,
            RemoteUsage: item.RemoteUsage.length,
            DirectDependencies: (graph.dependencies.get(item.Path) || []).length,
            DirectDependents: (graph.dependents.get(item.Path) || []).length
        },
        CollectionLimit: collectionLimit,
        ...(output.detail === 'deep' ? { SourceHash: item.SourceHash || null } : {})
    }));

    return stringifyBounded({
        Task: task,
        KeywordsAnalyzed: keywords,
        RelevantFiles: matches,
        Page: {
            Offset: offset,
            Limit: limit,
            Returned: matches.length,
            Total: ranked.length,
            NextOffset: offset + matches.length < ranked.length ? offset + matches.length : null
        },
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema),
        Suggestion: matches.length === 0
            ? 'Use a concrete module, remote, function, attribute, or gameplay noun.'
            : undefined
    }, output.maxChars, ['RelevantFiles']);
}
