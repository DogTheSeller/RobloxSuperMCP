import { cacheMetadata, loadBrain } from './brain_store.js';
import { findRankedItems } from './search_utils.js';
import { clampInteger } from './studio_utils.js';

const METHOD_STAGE = {
    FireServer: 'Client Intent',
    InvokeServer: 'Client Intent',
    OnServerEvent: 'Server Receiver',
    OnServerInvoke: 'Server Receiver',
    FireClient: 'Server Response',
    FireAllClients: 'Server Broadcast',
    InvokeClient: 'Server Request',
    OnClientEvent: 'Client Receiver',
    OnClientInvoke: 'Client Receiver'
};

export async function run(args) {
    const query = String(args.variable_name || args.currency || '').trim();
    if (!query) return JSON.stringify({ error: 'Please provide a variable, remote, or state name to trace.' });

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);

    const limit = clampInteger(args.limit, 30, 1, 100);
    const ranked = findRankedItems(loaded.brain.AllItems, query, limit);
    const relevantNames = new Set(ranked.map(result => result.item.Name.toLowerCase()));
    const remoteNames = new Set(
        loaded.brain.AllItems
            .filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class))
            .filter(item => relevantNames.has(item.Name.toLowerCase()))
            .map(item => item.Name.toLowerCase())
    );
    for (const { item } of ranked) {
        for (const usage of item.RemoteUsage) {
            if (usage.Name.toLowerCase().includes(query.toLowerCase())) remoteNames.add(usage.Name.toLowerCase());
        }
    }

    const remoteActivity = [];
    const persistenceEvidence = [];
    for (const item of loaded.brain.AllItems) {
        for (const usage of item.RemoteUsage) {
            if (!remoteNames.has(usage.Name.toLowerCase())) continue;
            remoteActivity.push({
                Stage: METHOD_STAGE[usage.Method] || 'Remote Activity',
                Remote: usage.Name,
                Method: usage.Method,
                Script: item.Name,
                Path: item.Path,
                Evidence: `${usage.Symbol || usage.Name}.${usage.Method}`
            });
        }
        for (const store of item.DataStoreUsage) {
            if (ranked.some(result => result.item.Path === item.Path)) {
                persistenceEvidence.push({
                    DataStore: store.Name,
                    Method: store.Method,
                    Script: item.Name,
                    Path: item.Path,
                    Evidence: `DataStoreService:${store.Method}`,
                    Confidence: 'Component matched query; payload-to-store causality is not proven.'
                });
            }
        }
    }

    const stageOrder = ['Client Intent', 'Server Receiver', 'Server Response', 'Server Broadcast', 'Server Request', 'Client Receiver', 'Remote Activity'];
    remoteActivity.sort((a, b) => stageOrder.indexOf(a.Stage) - stageOrder.indexOf(b.Stage));

    const boundedRemoteActivity = remoteActivity.slice(0, 500);
    const boundedPersistence = persistenceEvidence.slice(0, 200);
    return JSON.stringify({
        Query: query,
        TraceStatus: remoteActivity.length > 0 ? 'Observed participants found' : 'No explicit remote activity found',
        ObservedRemoteActivity: boundedRemoteActivity,
        PersistenceEvidence: boundedPersistence,
        RelatedComponents: args.include_related === false ? [] : ranked.map(({ item, match }) => ({
            Name: item.Name,
            ClassName: item.Class,
            Path: item.Path,
            RelevanceScore: match.score,
            MatchedTerms: match.matchedTokens
        })),
        Limitations: [
            'Entries are observed participants sorted by lifecycle role, not a proven causal execution path.',
            'Dynamic remote lookup, payload aliases, and table-indirected calls may require manual inspection.'
        ],
        EvidenceCounts: {
            RemoteActivities: remoteActivity.length,
            PersistenceRecords: persistenceEvidence.length,
            RelatedComponents: ranked.length
        },
        ResultBounds: {
            RemoteActivityLimit: 500,
            PersistenceEvidenceLimit: 200,
            RemoteActivityTruncated: remoteActivity.length > boundedRemoteActivity.length,
            PersistenceEvidenceTruncated: persistenceEvidence.length > boundedPersistence.length
        },
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }, null, 2);
}
