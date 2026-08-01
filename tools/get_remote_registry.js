import { cacheMetadata, loadBrain } from './brain_store.js';
import { buildRemoteUsageIndex, participantsForRemote } from './remote_utils.js';
import { paginate } from './studio_utils.js';

const SERVER_METHODS = new Set(['OnServerEvent', 'OnServerInvoke']);
const CLIENT_SEND_METHODS = new Set(['FireServer', 'InvokeServer']);

export async function run(args = {}) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);

    const scripts = loaded.brain.AllItems.filter(item => item.Class.endsWith('Script'));
    const usageIndex = buildRemoteUsageIndex(scripts, executionSide);
    const remoteNameCounts = new Map();
    for (const item of loaded.brain.AllItems.filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class))) {
        const normalizedName = item.Name.toLowerCase();
        remoteNameCounts.set(normalizedName, (remoteNameCounts.get(normalizedName) || 0) + 1);
    }
    const nameFilter = String(args.remote_name || '').trim().toLowerCase();
    let endpoints = loaded.brain.AllItems
        .filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class))
        .filter(item => !nameFilter || item.Name.toLowerCase().includes(nameFilter))
        .map(remote => {
            const allParticipants = participantsForRemote(usageIndex, remote.Name);
            const methods = new Set(allParticipants.map(participant => participant.Method));
            const occurrenceCount = allParticipants.reduce((total, participant) =>
                total + participant.Occurrences, 0);
            const ambiguousName = (remoteNameCounts.get(remote.Name.toLowerCase()) || 0) > 1;
            const issues = [];
            if (ambiguousName) {
                issues.push(`Multiple indexed endpoints are named '${remote.Name}'; participant evidence is name-level, not path-proven.`);
            }
            if ([...methods].some(method => CLIENT_SEND_METHODS.has(method)) &&
                ![...methods].some(method => SERVER_METHODS.has(method))) {
                issues.push('Indexed client send has no indexed server receiver; dynamic or unresolved usage may exist.');
            }
            if (allParticipants.length === 0) issues.push('No indexed usage found; this is incomplete evidence, not proof that the remote is unused.');
            const participants = allParticipants.slice(0, 500);

            return {
                Name: remote.Name,
                Type: remote.Class,
                Location: remote.Path,
                Participants: participants,
                ParticipantCount: allParticipants.length,
                OccurrenceCount: occurrenceCount,
                ParticipantsTruncated: allParticipants.length > participants.length,
                EndpointIdentity: ambiguousName ? 'ambiguous-name' : 'unique-indexed-name',
                ParticipantAttribution: ambiguousName ? 'remote-name-only' : 'unique-indexed-name',
                MethodsObserved: [...methods].sort(),
                Findings: issues,
                ContractName: {
                    FollowsVerbNoun: /^(Request|Notify|Report|Submit|Query|Fetch|Update|Sync|Broadcast|Prompt|Confirm|Cancel|Equip|Unequip|Activate|Deactivate|Purchase|Redeem|Claim|Collect|Interact)[A-Z0-9]/.test(remote.Name),
                    Current: remote.Name
                },
                EvidenceCoverage: participants.length > 0
                    ? ambiguousName ? 'name-indexed-participants' : 'indexed-participants'
                    : 'endpoint-only'
            };
        });
    if (args.include_unused === false) {
        endpoints = endpoints.filter(endpoint => endpoint.Participants.length > 0);
    }
    const page = paginate(endpoints, args, { defaultLimit: 100, maxLimit: 300 });

    return JSON.stringify({
        TotalRemotesFound: endpoints.length,
        RemotesWithObservedUsage: endpoints.filter(endpoint => endpoint.Participants.length > 0).length,
        RemoteEndpoints: page.Items,
        Page: page.Page,
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }, null, 2);
}

function executionSide(script) {
    if (script.Class === 'LocalScript') return 'Client';
    if (script.Class === 'Script' && ['ServerScriptService', 'ServerStorage', 'Workspace'].includes(script.Category)) return 'Server';
    return 'Unknown/Shared';
}
