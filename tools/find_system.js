import { cacheMetadata, loadBrain } from './brain_store.js';
import { findRankedItems, matchEvidence, tokenize } from './search_utils.js';
import { normalizePagination } from './studio_utils.js';

const GROUPS = {
    ServerScriptService: 'ServerServices',
    ReplicatedStorage: 'SharedComponents',
    StarterPlayer: 'ClientControllers',
    StarterGui: 'UIElements'
};

export async function run(args) {
    const query = String(args.system_name || '').trim();
    const searchTokens = tokenize(query);
    if (!query || searchTokens.length === 0) {
        return JSON.stringify({ error: 'Provide a specific system name such as trade, inventory, or currency.' });
    }

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);

    const allowedCategories = Array.isArray(args.categories)
        ? new Set(args.categories.map(String))
        : null;
    const ranked = findRankedItems(loaded.brain.AllItems, query, 500)
        .filter(({ item }) => !allowedCategories || allowedCategories.has(item.Category));
    const { offset, limit } = normalizePagination(args, { defaultLimit: 75, maxLimit: 300 });
    const selected = ranked.slice(offset, offset + limit);
    const output = {
        SystemQuery: query,
        SearchTokens: searchTokens,
        ServerServices: [],
        SharedComponents: [],
        ClientControllers: [],
        UIElements: [],
        RemoteEndpoints: [],
        OtherComponents: []
    };

    for (const { item, match } of selected) {
        const entry = {
            RelevanceScore: match.score,
            MatchedTerms: match.matchedTokens,
            MatchReason: explainMatch(item, match.matchedTokens),
            MatchEvidence: matchEvidence(item, query),
            Confidence: confidenceFor(item, query, match.score),
            Name: item.Name,
            ClassName: item.Class,
            Path: item.Path,
            Requires: item.Requires,
            ServicesUsed: item.ServicesUsed
        };
        if (['RemoteEvent', 'RemoteFunction'].includes(item.Class)) {
            output.RemoteEndpoints.push(entry);
        } else {
            output[GROUPS[item.Category] || 'OtherComponents'].push(entry);
        }
    }

    const groups = ['ServerServices', 'SharedComponents', 'ClientControllers', 'UIElements', 'RemoteEndpoints', 'OtherComponents'];
    output.ReturnedMatches = groups.reduce((total, group) => total + output[group].length, 0);
    output.TotalMatches = ranked.length;
    output.Page = {
        Offset: offset,
        Limit: limit,
        Returned: output.ReturnedMatches,
        Total: ranked.length,
        NextOffset: offset + selected.length < ranked.length ? offset + selected.length : null
    };
    output.Cache = cacheMetadata(loaded.brain, loaded.staleSchema);
    if (output.TotalMatches === 0) {
        output.Suggestion = 'Try a remote name, module name, function name, or rerun analyze_project for fresh source metadata.';
    }
    return JSON.stringify(output, null, 2);
}

function confidenceFor(item, query, score) {
    const lowered = query.toLowerCase();
    if (item.Path.toLowerCase() === lowered) return 'exact-path';
    if (item.Name.toLowerCase() === lowered) return 'exact-name';
    return score >= 12 ? 'high' : score >= 7 ? 'medium' : 'low';
}

function explainMatch(item, terms) {
    const name = item.Name.toLowerCase();
    if (terms.some(term => name.includes(term))) return 'name';
    const path = item.Path.toLowerCase();
    if (terms.some(term => path.includes(term))) return 'path';
    return 'indexed source metadata';
}
