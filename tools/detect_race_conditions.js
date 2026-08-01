import { cacheMetadata, loadBrain } from './brain_store.js';
import {
    loadAuditSources,
    stripCommentsAndStrings,
    summarizeAudit
} from './audit_utils.js';
import { lineNumberAt } from './studio_utils.js';

const YIELD_PATTERN = /(?:task\.(?:wait|delay)|WaitForChild|:\s*Wait|GetAsync|UpdateAsync|InvokeServer|InvokeClient|TeleportAsync)\s*\(/g;

export async function run(args = {}, studioCommunicator) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const audit = await loadAuditSources(loaded.brain, args, studioCommunicator);
    const findings = [];
    const anchorWriters = [];

    for (const record of audit.sources) {
        const source = stripCommentsAndStrings(record.Source);
        for (const match of source.matchAll(YIELD_PATTERN)) {
            const before = source.slice(Math.max(0, match.index - 1200), match.index);
            const after = source.slice(match.index + match[0].length, match.index + 2200);
            const assigned = [...before.matchAll(/\blocal\s+([A-Za-z_]\w*)\s*=/g)].map(item => item[1]);
            const stale = assigned.find(name => new RegExp(`\\b${name}\\b`).test(after));
            if (stale && !/(sessionId|generation|token|Parent\s*[~=]=|IsDescendantOf)/.test(after)) {
                findings.push({
                    Rule: 'read-yield-use',
                    Severity: 'Warning',
                    Path: record.Path,
                    Line: lineNumberAt(source, match.index),
                    Message: `Local '${stale}' is captured before a yield and reused afterward without obvious revalidation.`,
                    Confidence: 'inferred'
                });
            }
        }
        for (const match of source.matchAll(/\.Anchored\s*=\s*(?:true|false)/g)) {
            anchorWriters.push({
                Path: record.Path,
                Line: lineNumberAt(source, match.index),
                Evidence: match[0]
            });
        }
        for (const match of source.matchAll(/\.(?:Touched|OnServerEvent|Event)\s*:\s*Connect\s*\(/g)) {
            const window = source.slice(match.index, match.index + 2500);
            if (!/(debounce|busy|processing|inFlight|locked)\s*(?:\[|=)/i.test(window)) {
                findings.push({
                    Rule: 'reentrant-signal',
                    Severity: 'Warning',
                    Path: record.Path,
                    Line: lineNumberAt(source, match.index),
                    Message: 'Potentially re-entrant signal handler has no visible single-entry guard.',
                    Confidence: 'inferred'
                });
            }
        }
        if (/\btask\.(?:spawn|defer)\s*\(/.test(source) && /\.State\s*=|SetAttribute\s*\(/.test(source) &&
            !/(generation|version|token|mutex|lock)/i.test(source)) {
            findings.push({
                Rule: 'concurrent-state-write',
                Severity: 'Warning',
                Path: record.Path,
                Line: 1,
                Message: 'Concurrent work writes state without visible generation, token, or lock arbitration.',
                Confidence: 'inferred'
            });
        }
    }

    const anchorPaths = new Set(anchorWriters.map(item => item.Path));
    if (anchorPaths.size > 1) {
        for (const writer of anchorWriters) {
            findings.push({
                Rule: 'multiple-anchor-authorities',
                Severity: 'Error',
                ...writer,
                Message: `HumanoidRootPart.Anchored-style writes occur in ${anchorPaths.size} scripts; verify a single authority function.`,
                Confidence: 'observed'
            });
        }
    }

    return JSON.stringify(summarizeAudit('Race conditions and authority conflicts', findings, audit.coverage, {
        SharedStateEvidence: {
            AnchoredWriters: anchorWriters
        },
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }), null, 2);
}
