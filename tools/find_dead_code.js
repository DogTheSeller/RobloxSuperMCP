import { cacheMetadata, loadBrain } from './brain_store.js';
import { buildDependencyGraph } from './graph_utils.js';
import { paginate, summarizeItem } from './studio_utils.js';

export async function run(args = {}) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const brain = loaded.brain;
    const graph = buildDependencyGraph(brain.AllItems);
    const scripts = brain.AllItems.filter(item => item.Class.endsWith('Script'));
    const globalCalls = new Set(brain.AllItems.flatMap(item =>
        (item.Calls || []).map(call => call.toLowerCase())
    ));
    const remoteNamesWithUsage = new Set(brain.AllItems.flatMap(item =>
        (item.RemoteUsage || []).map(usage => usage.Name.toLowerCase())
    ));
    const candidates = [];

    for (const item of brain.AllItems) {
        if (item.Class === 'ModuleScript') {
            const dependents = graph.dependents.get(item.Path) || [];
            if (dependents.length === 0) {
                candidates.push({
                    Kind: 'ModuleScript',
                    ...summarizeItem(item),
                    Confidence: 'medium',
                    Evidence: 'No resolved indexed dependents.',
                    Caveat: 'Dynamic require paths and asset-ID requires are not proven by the index.'
                });
            }
            for (const functionName of item.Functions) {
                const leaf = functionName.split(/[.:]/).at(-1);
                const observedCall = globalCalls.has(leaf.toLowerCase());
                if (!observedCall) {
                    candidates.push({
                        Kind: 'Function',
                        Name: functionName,
                        Path: item.Path,
                        ClassName: item.Class,
                        Confidence: 'low',
                        Evidence: 'No matching call symbol was indexed.',
                        Caveat: 'Table dispatch, callbacks, exports, and string-based access may be invisible.'
                    });
                }
            }
        }
        if (['RemoteEvent', 'RemoteFunction'].includes(item.Class)) {
            if (!remoteNamesWithUsage.has(item.Name.toLowerCase())) {
                candidates.push({
                    Kind: 'Remote',
                    ...summarizeItem(item),
                    Confidence: 'medium',
                    Evidence: 'No indexed caller or listener.',
                    Caveat: 'Dynamic lookup may exist.'
                });
            }
        }
    }

    const attributeOwners = new Map();
    for (const item of scripts) {
        for (const attribute of item.Attributes) {
            const owners = attributeOwners.get(attribute.toLowerCase()) || [];
            owners.push(item);
            attributeOwners.set(attribute.toLowerCase(), owners);
        }
    }
    for (const [attribute, owners] of attributeOwners) {
        if (owners.length === 1) {
            candidates.push({
                Kind: 'Attribute',
                Name: attribute,
                Path: owners[0].Path,
                ClassName: owners[0].Class,
                Confidence: 'low',
                Evidence: 'The attribute appears in only one indexed script.',
                Caveat: 'The index does not yet distinguish reads from writes.'
            });
        }
    }

    const kindFilter = String(args.kind || '').toLowerCase();
    const filtered = kindFilter
        ? candidates.filter(candidate => candidate.Kind.toLowerCase() === kindFilter)
        : candidates;
    const page = paginate(filtered, args, { defaultLimit: 100, maxLimit: 300 });
    return JSON.stringify({
        Status: 'Candidates Found',
        Candidates: page.Items,
        Page: page.Page,
        Summary: Object.fromEntries(['ModuleScript', 'Function', 'Remote', 'Attribute'].map(kind => [
            kind,
            filtered.filter(item => item.Kind === kind).length
        ])),
        ConfidencePolicy: 'Candidates are review targets, never automatic deletion authorization.',
        Cache: cacheMetadata(brain, loaded.staleSchema)
    }, null, 2);
}
