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
    const audit = await loadAuditSources(loaded.brain, args, studioCommunicator);
    const findings = [];

    for (const record of audit.sources) {
        const sanitized = stripCommentsAndStrings(record.Source);
        const analysisRecord = { ...record, Source: sanitized };
        const hasLifecycleOwner = /\b(?:Janitor|Trove|Maid)\b/.test(sanitized);
        if (/[.:]Connect\s*\(/.test(sanitized) && !hasLifecycleOwner) {
            findings.push(...findPattern(analysisRecord, 'unowned-connections', /[.:]Connect\s*\(/,
                'Signal connections exist without visible Janitor, Trove, or Maid ownership.', 'Warning', 'inferred'));
        }
        if (/\btask\.(?:spawn|defer|delay)\s*\(/.test(sanitized) && !/\btask\.cancel\s*\(/.test(sanitized)) {
            findings.push(...findPattern(analysisRecord, 'uncancellable-thread', /\btask\.(?:spawn|defer|delay)\s*\(/,
                'Spawned or delayed work has no visible cancellation path.', 'Warning', 'inferred'));
        }
        findings.push(...findPattern(analysisRecord, 'unbounded-wait-for-child', /WaitForChild\s*\(\s*[^,\n)]+\)/,
            'WaitForChild() has no explicit timeout.', 'Error'));
        findings.push(...findPattern(analysisRecord, 'signal-wait', /(?:ChildAdded|CharacterAdded|Event|OnInvoke)\s*:\s*Wait\s*\(\s*\)/,
            'Signal:Wait() can yield indefinitely if the producer is destroyed or never fires.', 'Warning', 'inferred'));
        if (/\btask\.(?:wait|delay)\s*\(/.test(sanitized) &&
            /\b(?:player|character|humanoid|rootPart)\b/i.test(sanitized) &&
            !/(Parent\s*~=|Parent\s*==|Players:GetPlayer|Character\s*==|sessionId|generation)/i.test(sanitized)) {
            findings.push({
                Rule: 'stale-reference-after-yield',
                Severity: 'Warning',
                Path: record.Path,
                Line: 1,
                Message: 'The script combines yielding work with player/character references but has no obvious post-yield revalidation.',
                Confidence: 'inferred'
            });
        }
        if (hasLifecycleOwner && /function\s+[\w.:]*Destroy\s*\(/.test(sanitized) &&
            !/[._](?:janitor|trove|maid)\s*:\s*(?:Destroy|Clean|Cleanup)\s*\(/i.test(sanitized)) {
            findings.push({
                Rule: 'destroy-without-owner-cleanup',
                Severity: 'Error',
                Path: record.Path,
                Line: 1,
                Message: 'A lifecycle owner and Destroy method exist, but cleanup is not visible inside the script.',
                Confidence: 'inferred'
            });
        }
    }

    return JSON.stringify(summarizeAudit('Lifecycle and memory safety', findings, audit.coverage, {
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }), null, 2);
}
