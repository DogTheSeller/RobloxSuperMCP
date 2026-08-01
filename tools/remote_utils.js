export function buildRemoteUsageIndex(scripts, sideResolver) {
    const index = new Map();
    for (const script of scripts) {
        for (const usage of script.RemoteUsage || []) {
            const remoteName = String(usage.Name || '').trim();
            const method = String(usage.Method || '').trim();
            if (!remoteName || !method) continue;
            const participant = {
                Script: script.Name,
                Path: script.Path,
                Side: sideResolver(script),
                Method: method,
                Symbol: String(usage.Symbol || remoteName),
                IndexedLine: usage.Line ? Number(usage.Line) : null,
                IndexedSourceHash: script.SourceHash || null,
                Occurrences: 1
            };
            const normalizedName = remoteName.toLowerCase();
            let remoteEntry = index.get(normalizedName);
            if (!remoteEntry) {
                remoteEntry = new Map();
                index.set(normalizedName, remoteEntry);
            }
            const observationKey = [
                participant.Path,
                participant.IndexedSourceHash || '',
                participant.Symbol,
                participant.Method,
                participant.IndexedLine || ''
            ].join('\u0000');
            const existing = remoteEntry.get(observationKey);
            if (existing) {
                existing.Occurrences += 1;
            } else {
                remoteEntry.set(observationKey, participant);
            }
        }
    }
    return new Map([...index].map(([name, observations]) => [name, [...observations.values()]]));
}

export function participantsForRemote(index, remoteName) {
    return index.get(String(remoteName || '').trim().toLowerCase()) || [];
}
