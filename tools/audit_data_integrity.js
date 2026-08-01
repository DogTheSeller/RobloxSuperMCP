import { cacheMetadata, loadBrain } from './brain_store.js';
import {
    findPattern,
    loadAuditSources,
    stripCommentsAndStrings,
    summarizeAudit
} from './audit_utils.js';

export async function run(args = {}, studioCommunicator) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const dataItems = loaded.brain.AllItems.filter(item =>
        item.ServicesUsed.includes('DataStoreService') ||
        item.DataStoreUsage.length > 0 ||
        /(ProfileStore|ProfileService|ProcessReceipt|DataStore)/i.test(`${item.Name} ${item.SearchTerms.join(' ')}`)
    );
    const scopedArgs = {
        ...args,
        query: args.query || ''
    };
    const audit = await loadAuditSources({
        ...loaded.brain,
        AllItems: dataItems
    }, scopedArgs, studioCommunicator);
    const findings = [];

    for (const record of audit.sources) {
        const source = stripCommentsAndStrings(record.Source);
        const analysisRecord = { ...record, Source: source };
        findings.push(...findPattern(analysisRecord, 'set-async', /:\s*SetAsync\s*\(/,
            'SetAsync can overwrite concurrent state; use session locking or guarded UpdateAsync.', 'Critical'));
        const hasDataCall = /:\s*(?:GetAsync|UpdateAsync|IncrementAsync|RemoveAsync|ListKeysAsync)\s*\(/.test(source);
        if (hasDataCall && !/\bpcall\s*\(/.test(source)) {
            findings.push({
                Rule: 'unprotected-data-call',
                Severity: 'Critical',
                Path: record.Path,
                Line: 1,
                Message: 'Persistence APIs are used without visible pcall error handling.',
                Confidence: 'observed'
            });
        }
        if (/(ProfileStore|ProfileService)/.test(source)) {
            if (!/(ListenToRelease|OnSessionEnd|EndSession|Release)/.test(source)) {
                findings.push({
                    Rule: 'profile-release-handling',
                    Severity: 'Error',
                    Path: record.Path,
                    Line: 1,
                    Message: 'Profile session usage has no visible release/session-end handler.',
                    Confidence: 'inferred'
                });
            }
            if (!/PlayerRemoving/.test(source)) {
                findings.push({
                    Rule: 'player-removing-release',
                    Severity: 'Warning',
                    Path: record.Path,
                    Line: 1,
                    Message: 'Profile session usage has no visible PlayerRemoving release path.',
                    Confidence: 'inferred'
                });
            }
        }
        if (/ProcessReceipt/.test(source)) {
            if (!/PurchaseGranted/.test(source)) {
                findings.push({
                    Rule: 'receipt-result',
                    Severity: 'Critical',
                    Path: record.Path,
                    Line: 1,
                    Message: 'ProcessReceipt exists without visible PurchaseGranted handling.',
                    Confidence: 'observed'
                });
            }
            if (!/(UpdateAsync|Profile|Save)/.test(source)) {
                findings.push({
                    Rule: 'receipt-persistence-before-grant',
                    Severity: 'Critical',
                    Path: record.Path,
                    Line: 1,
                    Message: 'Receipt processing lacks visible persistence before granting completion.',
                    Confidence: 'inferred'
                });
            }
        }
        if (/\btask\.(?:wait|delay|spawn)\s*\(/.test(source) &&
            /(profile|session|receipt)/i.test(source) &&
            !/(IsActive|sessionId|generation|Parent\s*~=)/.test(source)) {
            findings.push({
                Rule: 'persistence-stale-state-after-yield',
                Severity: 'Warning',
                Path: record.Path,
                Line: 1,
                Message: 'Persistence state crosses a yielding boundary without obvious session revalidation.',
                Confidence: 'inferred'
            });
        }
    }

    return JSON.stringify(summarizeAudit('Persistence and monetization integrity', findings, audit.coverage, {
        IndexedPersistenceComponents: dataItems.map(item => ({ Name: item.Name, Path: item.Path })),
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }), null, 2);
}
