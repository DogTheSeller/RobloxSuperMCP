import { cacheMetadata, loadBrain } from './brain_store.js';
import {
    findPattern,
    loadAuditSources,
    stripCommentsAndStrings,
    summarizeAudit
} from './audit_utils.js';
import { lineNumberAt } from './studio_utils.js';

const HOT_SIGNAL = /(?:RenderStepped|Heartbeat|Stepped|PreSimulation|PostSimulation)\s*[:.]Connect\s*\(/g;

export async function run(args = {}, studioCommunicator) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const audit = await loadAuditSources(loaded.brain, args, studioCommunicator);
    const findings = [];

    for (const record of audit.sources) {
        const source = stripCommentsAndStrings(record.Source);
        const analysisRecord = { ...record, Source: source };
        findings.push(...findPattern(analysisRecord, 'unbounded-loop', /\bwhile\s+true\s+do\b/,
            'Unbounded polling loops should be event-driven or have an explicit termination condition.', 'Warning'));
        findings.push(...findPattern(analysisRecord, 'legacy-pairs', /\b(?:pairs|ipairs)\s*\(/,
            'Use generalized iteration in new Luau code.', 'Info'));

        for (const hotMatch of source.matchAll(HOT_SIGNAL)) {
            const window = source.slice(hotMatch.index, hotMatch.index + 5000);
            const line = lineNumberAt(source, hotMatch.index);
            const checks = [
                [/\bInstance\.new\s*\(/, 'hot-instance-allocation', 'Instance allocation is visible inside a per-frame callback.', 'Error'],
                [/:Clone\s*\(/, 'hot-clone', 'Cloning is visible inside a per-frame callback.', 'Error'],
                [/:GetDescendants\s*\(/, 'hot-descendant-scan', 'GetDescendants() is visible inside a per-frame callback.', 'Error'],
                [/:FindFirstChild\s*\(/, 'hot-tree-lookup', 'FindFirstChild() is visible inside a per-frame callback.', 'Warning'],
                [/\{\s*\}/, 'hot-table-allocation', 'A table allocation is visible inside a per-frame callback.', 'Warning'],
                [/workspace:Raycast\s*\(/, 'hot-raycast', 'A per-frame raycast is visible; verify batching and ray budget.', 'Warning']
            ];
            for (const [pattern, rule, message, severity] of checks) {
                if (pattern.test(window)) {
                    findings.push({
                        Rule: rule,
                        Severity: severity,
                        Path: record.Path,
                        Line: line,
                        Message: message,
                        Confidence: 'inferred'
                    });
                }
            }
        }
        if (/\bGetDescendants\s*\(\s*\)/.test(source) && (source.match(/\bGetDescendants\s*\(\s*\)/g) || []).length >= 3) {
            findings.push({
                Rule: 'repeated-descendant-scans',
                Severity: 'Warning',
                Path: record.Path,
                Line: 1,
                Message: 'Three or more descendant scans are present; cache stable hierarchies where possible.',
                Confidence: 'observed'
            });
        }
        if (/\btable\.insert\s*\(/.test(source) && !/\btable\.create\s*\(/.test(source) &&
            /(MAX_|capacity|pool|projectile|npc|enemy)/i.test(source)) {
            findings.push({
                Rule: 'missing-preallocation',
                Severity: 'Info',
                Path: record.Path,
                Line: 1,
                Message: 'A capacity-oriented collection grows with table.insert() without visible table.create() pre-allocation.',
                Confidence: 'inferred'
            });
        }
    }

    return JSON.stringify(summarizeAudit('Hot-path performance and GC pressure', findings, audit.coverage, {
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    }), null, 2);
}
