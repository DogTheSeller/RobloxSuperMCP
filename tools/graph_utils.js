import { scoreItem } from './search_utils.js';

function buildNameIndex(items) {
    const index = new Map();
    for (const item of items) {
        const key = item.Name.toLowerCase();
        const bucket = index.get(key) || [];
        bucket.push(item);
        index.set(key, bucket);
    }
    return index;
}

export function buildDependencyGraph(items) {
    const byName = buildNameIndex(items);
    const dependencies = new Map();
    const dependents = new Map();
    const ambiguous = new Map();
    const unresolved = new Map();

    for (const item of items) {
        const resolved = [];
        const ambiguousRequirements = [];
        const unresolvedRequirements = [];
        for (const requiredName of item.Requires || []) {
            const candidates = (byName.get(requiredName.toLowerCase()) || [])
                .filter(candidate => candidate.Class === 'ModuleScript' && candidate.Path !== item.Path);
            if (candidates.length === 1) {
                const candidate = candidates[0];
                resolved.push(candidate);
                const reverse = dependents.get(candidate.Path) || [];
                reverse.push(item);
                dependents.set(candidate.Path, reverse);
            } else if (candidates.length > 1) {
                ambiguousRequirements.push({
                    Requirement: requiredName,
                    CandidatePaths: candidates.map(candidate => candidate.Path)
                });
            } else {
                unresolvedRequirements.push(requiredName);
            }
        }
        dependencies.set(item.Path, uniqueByPath(resolved));
        ambiguous.set(item.Path, ambiguousRequirements);
        unresolved.set(item.Path, unresolvedRequirements);
    }

    return { dependencies, dependents, ambiguous, unresolved };
}

export function findBestTarget(items, query) {
    const exactPath = items.find(item => item.Path.toLowerCase() === query.toLowerCase());
    if (exactPath) return { item: exactPath, confidence: 'exact-path', alternatives: [] };

    const exactNames = items.filter(item => item.Name.toLowerCase() === query.toLowerCase());
    if (exactNames.length === 1) return { item: exactNames[0], confidence: 'exact-name', alternatives: [] };

    const ranked = items
        .map(item => ({ item, match: scoreItem(item, query) }))
        .filter(result => result.match)
        .sort((a, b) => b.match.score - a.match.score);

    if (ranked.length === 0) return null;
    return {
        item: ranked[0].item,
        confidence: exactNames.length > 1 ? 'ambiguous-name' : 'ranked',
        alternatives: ranked.slice(1, 6).map(result => ({
            Name: result.item.Name,
            Path: result.item.Path,
            Score: result.match.score
        }))
    };
}

export function walkGraph(startPath, adjacency, maxDepth = 4) {
    const result = [];
    const visited = new Set([startPath]);
    let frontier = [{ path: startPath, depth: 0 }];

    while (frontier.length > 0) {
        const next = [];
        for (const node of frontier) {
            if (node.depth >= maxDepth) continue;
            for (const item of adjacency.get(node.path) || []) {
                if (visited.has(item.Path)) continue;
                visited.add(item.Path);
                result.push({ item, depth: node.depth + 1 });
                next.push({ path: item.Path, depth: node.depth + 1 });
            }
        }
        frontier = next;
    }
    return result;
}

export function uniqueByPath(items) {
    return [...new Map(items.map(item => [item.Path, item])).values()];
}

export function findCycles(startPath, adjacency, maxDepth = 12) {
    const cycles = [];
    const exploredAtDepth = new Map();
    const visit = (path, trail, depth) => {
        if (depth > maxDepth || cycles.length >= 100) return;
        const previousDepth = exploredAtDepth.get(path);
        if (previousDepth !== undefined && previousDepth < depth) return;
        exploredAtDepth.set(path, depth);
        for (const item of adjacency.get(path) || []) {
            const existing = trail.indexOf(item.Path);
            if (existing >= 0) {
                cycles.push([...trail.slice(existing), item.Path]);
                continue;
            }
            visit(item.Path, [...trail, item.Path], depth + 1);
        }
    };
    visit(startPath, [startPath], 0);
    const unique = new Map(cycles.map(cycle => [cycle.join(' -> '), cycle]));
    return [...unique.values()];
}
