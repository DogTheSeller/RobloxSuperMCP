import { cacheMetadata, loadBrain } from './brain_store.js';
import { stripCommentsAndStrings } from './audit_utils.js';
import { buildRemoteUsageIndex, participantsForRemote } from './remote_utils.js';
import {
    clampInteger,
    fetchScriptSources,
    lineNumberAt,
    normalizePagination,
    stableSortFindings
} from './studio_utils.js';

const SERVER_RECEIVERS = new Set(['OnServerEvent', 'OnServerInvoke']);
const CLIENT_SENDERS = new Set(['FireServer', 'InvokeServer']);
const SERVER_SENDERS = new Set(['FireClient', 'FireAllClients', 'InvokeClient']);
const CLIENT_RECEIVERS = new Set(['OnClientEvent', 'OnClientInvoke']);

function executionSide(item) {
    if (item.Class === 'LocalScript') return 'Client';
    if (item.Class === 'Script' && ['ServerScriptService', 'ServerStorage', 'Workspace'].includes(item.Category)) return 'Server';
    return item.Category === 'StarterPlayer' || item.Category === 'StarterGui' ? 'Client/Shared' : 'Unknown/Shared';
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function participantExpression(participant) {
    const symbol = String(participant.Symbol || '').trim();
    if (!symbol) return new RegExp(`\\b${escapeRegExp(participant.Method)}\\b`, 'g');
    return new RegExp(
        `\\b${escapeRegExp(symbol)}\\s*[.:]\\s*${escapeRegExp(participant.Method)}\\b`,
        'g'
    );
}

function attributedMatches(record, participant, expression) {
    const matches = [...record.Source.matchAll(expression)];
    const indexedLine = Number(participant.IndexedLine || 0);
    if (!indexedLine || record.SourceHash !== participant.IndexedSourceHash || matches.length <= 1) {
        return matches;
    }
    matches.sort((left, right) =>
        Math.abs(lineNumberAt(record.Source, left.index) - indexedLine) -
        Math.abs(lineNumberAt(record.Source, right.index) - indexedLine)
    );
    return matches.slice(0, 1);
}

function contractFindings(endpoint, participants, sourceByPath, ambiguousEndpointName = false) {
    const findings = [];
    const methods = new Set(participants.map(participant => participant.Method));
    const hasClientSend = [...methods].some(method => CLIENT_SENDERS.has(method));
    const hasServerReceiver = [...methods].some(method => SERVER_RECEIVERS.has(method));
    const hasServerSend = [...methods].some(method => SERVER_SENDERS.has(method));
    const hasClientReceiver = [...methods].some(method => CLIENT_RECEIVERS.has(method));
    if (ambiguousEndpointName) {
        findings.push({
            Rule: 'ambiguous-remote-identity',
            Severity: 'Error',
            Path: endpoint.Path,
            Message: `Multiple indexed remote endpoints are named '${endpoint.Name}'; name-only usage evidence cannot identify the target.`,
            Confidence: 'observed'
        });
    }

    if (hasClientSend && !hasServerReceiver) {
        findings.push({
            Rule: 'missing-server-receiver',
            Severity: 'Critical',
            Path: endpoint.Path,
            Message: 'An indexed client sender has no indexed server receiver.',
            Confidence: 'observed'
        });
    }
    if (hasServerSend && !hasClientReceiver) {
        findings.push({
            Rule: 'missing-client-receiver',
            Severity: 'Warning',
            Path: endpoint.Path,
            Message: 'An indexed server sender has no indexed client receiver.',
            Confidence: 'observed'
        });
    }
    if (!/^(Request|Notify|Report|Submit|Query|Fetch|Update|Sync|Broadcast|Prompt|Confirm|Cancel|Equip|Unequip|Activate|Deactivate|Purchase|Redeem|Claim|Collect|Interact)[A-Z0-9]/.test(endpoint.Name)) {
        findings.push({
            Rule: 'remote-verb-noun-name',
            Severity: 'Info',
            Path: endpoint.Path,
            Message: `Remote '${endpoint.Name}' does not clearly follow a verb-noun contract name.`,
            Confidence: 'inferred'
        });
    }

    const serverParticipants = [...new Map(
        participants
            .filter(item => SERVER_RECEIVERS.has(item.Method))
            .map(item => [`${item.Path}:${item.Symbol}:${item.Method}:${item.IndexedLine || ''}`, item])
    ).values()];
    for (const participant of serverParticipants) {
        const record = sourceByPath.get(participant.Path);
        if (!record) continue;
        const expression = participantExpression(participant);
        for (const markerMatch of attributedMatches(record, participant, expression)) {
            const marker = markerMatch.index;
            const afterMarker = record.Source.slice(marker + markerMatch[0].length);
            const nextHandler = afterMarker.search(
                /\b[A-Za-z_]\w*\s*[.:]\s*(?:OnServerEvent|OnServerInvoke)\b/
            );
            const windowEnd = nextHandler >= 0
                ? marker + markerMatch[0].length + nextHandler
                : marker + 4000;
            const window = record.Source.slice(marker, Math.min(marker + 4000, windowEnd));
            const line = lineNumberAt(record.Source, marker);
            if (!/\btypeof\s*\(/.test(window)) {
                findings.push({
                    Rule: 'runtime-payload-validation',
                    Severity: 'Critical',
                    Path: participant.Path,
                    Line: line,
                    Message: `No local typeof() payload validation is visible near ${participant.Method}.`,
                    Confidence: 'inferred'
                });
            }
            if (!/(debounce|rateLimit|cooldown|lastRequest|tokenBucket)/i.test(window)) {
                findings.push({
                    Rule: 'player-rate-limit',
                    Severity: 'Warning',
                    Path: participant.Path,
                    Line: line,
                    Message: 'No player-specific debounce or rate-limit evidence is visible near the server receiver.',
                    Confidence: 'inferred'
                });
            }
            if (/(purchase|buy|redeem|claim|reward|damage|hit|attack)/i.test(endpoint.Name) &&
                !/(ownership|owns|price|cost|balance|distance|magnitude|state|eligible|receipt)/i.test(window)) {
                findings.push({
                    Rule: 'server-authority-evidence',
                    Severity: 'Warning',
                    Path: participant.Path,
                    Line: line,
                    Message: 'Sensitive intent handler lacks visible ownership, cost, state, or spatial authority checks.',
                    Confidence: 'inferred'
                });
            }
        }
    }

    for (const participant of participants.filter(item => CLIENT_SENDERS.has(item.Method))) {
        const record = sourceByPath.get(participant.Path);
        if (!record) continue;
        const symbol = escapeRegExp(participant.Symbol);
        const expression = new RegExp(
            `\\b${symbol}\\s*[.:]\\s*${escapeRegExp(participant.Method)}\\s*\\(([^\\n)]*)`,
            'g'
        );
        for (const match of attributedMatches(record, participant, expression)) {
            if (/(?:\(\s*|,\s*)(?:-?\d+(?:\.\d+)?|math\.huge)\b/.test(match[0])) {
                findings.push({
                    Rule: 'client-supplied-number',
                    Severity: 'Critical',
                    Path: participant.Path,
                    Line: lineNumberAt(record.Source, match.index),
                    Message: 'Client remote call visibly sends a numerical value; review whether it dictates an authoritative outcome.',
                    Confidence: 'observed'
                });
            }
        }
    }
    return findings;
}

export async function run(args = {}, studioCommunicator) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const nameFilter = String(args.remote_name || '').trim().toLowerCase();
    const allEndpoints = loaded.brain.AllItems.filter(item =>
        ['RemoteEvent', 'RemoteFunction'].includes(item.Class) &&
        (!nameFilter || item.Name.toLowerCase().includes(nameFilter))
    );
    const { offset, limit } = normalizePagination(args, { defaultLimit: 50, maxLimit: 200 });
    const endpoints = allEndpoints.slice(offset, offset + limit);
    const scripts = loaded.brain.AllItems.filter(item => item.Class.endsWith('Script'));
    const usageIndex = buildRemoteUsageIndex(scripts, executionSide);
    const remoteNameCounts = new Map();
    for (const item of loaded.brain.AllItems.filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class))) {
        const key = item.Name.toLowerCase();
        remoteNameCounts.set(key, (remoteNameCounts.get(key) || 0) + 1);
    }
    const participantsByRemote = new Map();
    for (const endpoint of endpoints) {
        participantsByRemote.set(endpoint.Path, participantsForRemote(usageIndex, endpoint.Name).map(
            participant => ({
                ...participant,
                EndpointAttribution: 'symbol-and-method heuristic'
            })
        ));
    }
    const participantPaths = [...new Set([...participantsByRemote.values()].flat().map(item => item.Path))];
    const sourceRecords = studioCommunicator?.isAlive?.()
        ? await fetchScriptSources(studioCommunicator, participantPaths, {
            maxScripts: clampInteger(args.max_scripts, 100, 1, 200)
        })
        : [];
    const indexedHashByPath = new Map(scripts.map(script => [script.Path, script.SourceHash || null]));
    const hashMismatchPaths = sourceRecords
        .filter(record => {
            const indexedHash = indexedHashByPath.get(record.Path);
            return indexedHash && record.SourceHash !== indexedHash;
        })
        .map(record => record.Path);
    const missingIndexedSourceHashPaths = sourceRecords
        .filter(record => !indexedHashByPath.get(record.Path))
        .map(record => record.Path);
    const unsafeSourcePaths = new Set([...hashMismatchPaths, ...missingIndexedSourceHashPaths]);
    const liveSourcePaths = new Set(sourceRecords.map(record => record.Path));
    const sourceByPath = new Map(sourceRecords
        .filter(record => !unsafeSourcePaths.has(record.Path))
        .map(record => [
            record.Path,
            { ...record, Source: stripCommentsAndStrings(record.Source) }
    ]));
    const truncatedSources = sourceRecords.filter(record => record.Truncated).map(record => record.Path);
    const missingSourcePaths = participantPaths.filter(path => !liveSourcePaths.has(path));
    const evidenceIncomplete = truncatedSources.length > 0 ||
        missingSourcePaths.length > 0 ||
        hashMismatchPaths.length > 0 ||
        missingIndexedSourceHashPaths.length > 0;

    const allFindings = [];
    const contracts = endpoints.map(endpoint => {
        const participants = participantsByRemote.get(endpoint.Path) || [];
        const ambiguousEndpointName = (remoteNameCounts.get(endpoint.Name.toLowerCase()) || 0) > 1;
        const findings = contractFindings(endpoint, participants, sourceByPath, ambiguousEndpointName);
        allFindings.push(...findings);
        const boundedParticipants = participants.slice(0, 500);
        const boundedFindings = findings.slice(0, 200);
        const occurrenceCount = participants.reduce((total, participant) =>
            total + participant.Occurrences, 0);
        return {
            Name: endpoint.Name,
            Type: endpoint.Class,
            Path: endpoint.Path,
            Participants: boundedParticipants,
            ParticipantCount: participants.length,
            OccurrenceCount: occurrenceCount,
            ParticipantsTruncated: participants.length > boundedParticipants.length,
            EndpointIdentity: ambiguousEndpointName ? 'ambiguous-name' : 'unique-indexed-name',
            MethodsObserved: [...new Set(participants.map(item => item.Method))].sort(),
            Findings: boundedFindings,
            FindingCount: findings.length,
            FindingsTruncated: findings.length > boundedFindings.length,
            EvidenceCoverage: {
                IndexedParticipants: participants.length,
                LiveSourcesRead: participants.filter(item => sourceByPath.has(item.Path)).length
            }
        };
    });

    return JSON.stringify({
        Status: evidenceIncomplete
            ? 'INCOMPLETE'
            : allFindings.some(item => item.Severity === 'Critical')
                ? 'REVIEW REQUIRED'
                : 'PASS WITH ADVISORIES',
        Contracts: contracts,
        Summary: {
            RemoteCount: endpoints.length,
            Critical: allFindings.filter(item => item.Severity === 'Critical').length,
            Warning: allFindings.filter(item => item.Severity === 'Warning').length,
            Info: allFindings.filter(item => item.Severity === 'Info').length
        },
        Findings: stableSortFindings(allFindings).slice(0, 1000),
        FindingsTruncated: allFindings.length > 1000,
        Page: {
            Offset: offset,
            Limit: limit,
            Returned: endpoints.length,
            Total: allEndpoints.length,
            NextOffset: offset + endpoints.length < allEndpoints.length ? offset + endpoints.length : null
        },
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema),
        Evidence: sourceRecords.length ? 'live-source + indexed-network-usage' : 'indexed-network-usage',
        TruncatedSources: truncatedSources.slice(0, 100),
        MissingSourcePaths: missingSourcePaths.slice(0, 100),
        HashMismatchPaths: hashMismatchPaths.slice(0, 100),
        MissingIndexedSourceHashPaths: missingIndexedSourceHashPaths.slice(0, 100),
        Caveat: 'Static evidence cannot prove dynamically resolved remotes or runtime validation behavior.'
    }, null, 2);
}
