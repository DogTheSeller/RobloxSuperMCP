import {
    clampInteger,
    fetchScriptSources,
    lineNumberAt,
    stableSortFindings
} from './studio_utils.js';

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);

export function selectIndexedScripts(brain, args = {}) {
    const side = String(args.side || 'all').toLowerCase();
    const query = String(args.query || '').trim().toLowerCase();
    return brain.AllItems.filter(item => {
        if (!SCRIPT_CLASSES.has(item.Class)) return false;
        if (side === 'server' && !['ServerScriptService', 'ServerStorage', 'Workspace'].includes(item.Category)) return false;
        if (side === 'client' && !['StarterPlayer', 'StarterGui', 'StarterPack'].includes(item.Category)) return false;
        if (query && !`${item.Name} ${item.Path}`.toLowerCase().includes(query)) return false;
        return true;
    });
}

export async function loadAuditSources(brain, args, studioCommunicator) {
    const scripts = selectIndexedScripts(brain, args);
    const offset = clampInteger(args.offset, 0, 0, 100_000);
    const maxScripts = clampInteger(args.max_scripts, 75, 1, 200);
    const selected = scripts.slice(offset, offset + maxScripts);
    if (!studioCommunicator?.isAlive?.()) {
        return {
            sources: [],
            selected,
            coverage: {
                Mode: 'indexed-metadata-only',
                ScriptsSelected: selected.length,
                SourcesRead: 0,
                MissingSourceCount: selected.length,
                MissingSources: selected.map(item => item.Path).slice(0, 100),
                CompleteSourceCoverage: false,
                TotalEligibleScripts: scripts.length,
                NextOffset: offset + selected.length < scripts.length ? offset + selected.length : null
            }
        };
    }
    const sources = await fetchScriptSources(studioCommunicator, selected.map(item => item.Path), {
        maxScripts
    });
    const truncatedSources = sources.filter(record => record.Truncated).map(record => record.Path);
    const returnedPaths = new Set(sources.map(record => record.Path));
    const missingSources = selected.map(item => item.Path).filter(path => !returnedPaths.has(path));
    return {
        sources,
        selected,
        coverage: {
            Mode: 'live-source',
            ScriptsSelected: selected.length,
            SourcesRead: sources.length,
            TruncatedSourceCount: truncatedSources.length,
            TruncatedSources: truncatedSources.slice(0, 100),
            MissingSourceCount: missingSources.length,
            MissingSources: missingSources.slice(0, 100),
            CompleteSourceCoverage: truncatedSources.length === 0 && missingSources.length === 0,
            TotalEligibleScripts: scripts.length,
            NextOffset: offset + selected.length < scripts.length ? offset + selected.length : null
        }
    };
}

export function findPattern(sourceRecord, rule, pattern, message, severity = 'Warning', confidence = 'observed') {
    const findings = [];
    const expression = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of sourceRecord.Source.matchAll(expression)) {
        findings.push({
            Rule: rule,
            Severity: severity,
            Path: sourceRecord.Path,
            Line: lineNumberAt(sourceRecord.Source, match.index),
            Evidence: String(match[0]).slice(0, 160),
            Message: message,
            Confidence: confidence
        });
    }
    return findings;
}

export function summarizeAudit(name, findings, coverage, extra = {}) {
    const sorted = stableSortFindings(findings);
    const bounded = sorted.slice(0, 1000);
    return {
        Audit: name,
        Status: sorted.some(item => ['Critical', 'Error'].includes(item.Severity))
            ? 'REVIEW REQUIRED'
            : coverage.CompleteSourceCoverage === false ? 'INCOMPLETE'
            : sorted.length > 0 ? 'ADVISORY' : 'PASS',
        Summary: Object.fromEntries(['Critical', 'Error', 'Warning', 'Info'].map(severity => [
            severity,
            sorted.filter(item => item.Severity === severity).length
        ])),
        Findings: bounded,
        TotalFindings: sorted.length,
        FindingsTruncated: sorted.length > bounded.length,
        Coverage: coverage,
        EvidenceSemantics: {
            observed: 'Directly present in live source or indexed project data.',
            inferred: 'A review target derived from incomplete static evidence.',
            unknown: 'The available evidence cannot establish the condition.'
        },
        ...extra
    };
}

export function stripCommentsAndStrings(source) {
    return String(source || '')
        .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, match => match.replace(/[^\n]/g, ' '))
        .replace(/--[^\n]*/g, match => match.replace(/[^\n]/g, ' '))
        .replace(/\[(=*)\[[\s\S]*?\]\1\]/g, match => match.replace(/[^\n]/g, ' '))
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => match.replace(/[^\n]/g, ' '));
}
