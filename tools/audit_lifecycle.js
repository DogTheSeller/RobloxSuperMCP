import { cacheMetadata, loadBrain } from './brain_store.js';
import {
    findPattern,
    loadAuditSources,
    stripCommentsAndStrings,
    summarizeAudit
} from './audit_utils.js';
import { normalizeOutputOptions, stringifyBounded } from './studio_utils.js';

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

export async function graph(args = {}, studioCommunicator) {
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const output = normalizeOutputOptions({ ...args, max_results: args.max_results ?? args.max_scripts });
    const audit = await loadAuditSources(loaded.brain, {
        ...args,
        max_scripts: output.maxResults
    }, studioCommunicator);
    const graphs = audit.sources.map(buildLifecycleGraph);
    const shaped = graphs.map(item => output.detail === 'compact'
        ? { Path: item.Path, Summary: item.Summary }
        : output.detail === 'normal'
            ? { ...item, SourceFunctions: undefined }
            : item);
    const result = {
        Status: audit.coverage.CompleteSourceCoverage === false ? 'INCOMPLETE' : 'Lifecycle Graph Ready',
        Summary: {
            Scripts: graphs.length,
            Connections: graphs.reduce((total, item) => total + item.Connections.length, 0),
            UnownedConnections: graphs.reduce((total, item) => total + item.Summary.UnownedConnections, 0),
            Tasks: graphs.reduce((total, item) => total + item.Tasks.length, 0),
            UncancelledTasks: graphs.reduce((total, item) => total + item.Summary.UncancelledTasks, 0)
        },
        Graphs: shaped,
        Coverage: audit.coverage,
        EvidenceQuality: 'line-aware lexical ownership map; dynamic cleanup is reported as unknown',
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    };
    return stringifyBounded(result, output.maxChars, ['Graphs']);
}

export function buildLifecycleGraph(record) {
    const source = stripCommentsAndStrings(record.Source);
    const lines = source.split('\n');
    const owners = [];
    const sourceFunctions = [];
    const connections = [];
    const tasks = [];

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const owner = line.match(/\b(?:local\s+)?([A-Za-z_]\w*)\s*=\s*(Janitor|Trove|Maid)\s*[.:]\s*new\s*\(/);
        if (owner) owners.push({ Name: owner[1], Type: owner[2], Line: lineNumber });
        const definition = line.match(/\b(?:local\s+)?function\s+([\w.:]+)\s*\(/);
        if (definition) sourceFunctions.push({ Name: definition[1], Line: lineNumber });

        const connect = line.match(/(?:(?:local\s+)?([A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.:[\]]*)[.:]Connect\s*\(/);
        if (connect) {
            const binding = connect[1] || null;
            const cleanup = binding ? findLine(lines, new RegExp(`\\b${escapeRegExp(binding)}\\s*:\\s*Disconnect\\s*\\(`)) : null;
            const manager = findManagerOwnership(lines, binding, lineNumber);
            connections.push({
                Signal: connect[2],
                Binding: binding,
                Line: lineNumber,
                Cleanup: cleanup ? { Kind: 'Disconnect', Line: cleanup } : manager,
                Status: cleanup || manager ? 'owned' : 'unowned'
            });
        }

        const task = line.match(/(?:(?:local\s+)?([A-Za-z_]\w*)\s*=\s*)?\btask\.(spawn|defer|delay)\s*\(\s*([A-Za-z_]\w*)?/);
        if (task) {
            const binding = task[1] || null;
            const cleanup = binding ? findLine(lines, new RegExp(`\\btask\\.cancel\\s*\\(\\s*${escapeRegExp(binding)}\\b`)) : null;
            const manager = findManagerOwnership(lines, binding, lineNumber);
            tasks.push({
                Kind: task[2],
                Handler: task[3] || 'inline',
                Binding: binding,
                Line: lineNumber,
                Cleanup: cleanup ? { Kind: 'task.cancel', Line: cleanup } : manager,
                Status: cleanup || manager ? 'owned' : 'uncancelled'
            });
        }
    });

    return {
        Path: record.Path,
        Owners: owners,
        SourceFunctions: sourceFunctions,
        Connections: connections,
        Tasks: tasks,
        Summary: {
            OwnedConnections: connections.filter(item => item.Status === 'owned').length,
            UnownedConnections: connections.filter(item => item.Status === 'unowned').length,
            CancelledTasks: tasks.filter(item => item.Status === 'owned').length,
            UncancelledTasks: tasks.filter(item => item.Status === 'uncancelled').length
        }
    };
}

function findLine(lines, pattern) {
    const index = lines.findIndex(line => pattern.test(line));
    return index >= 0 ? index + 1 : null;
}

function findManagerOwnership(lines, binding, fallbackLine) {
    if (!binding) {
        return /\b([A-Za-z_]\w*)\s*:\s*(?:Add|GiveTask)\s*\([^\n]*[.:]Connect\s*\(/.test(lines[fallbackLine - 1])
            ? { Kind: 'lifecycle-owner', Line: fallbackLine }
            : null;
    }
    const pattern = new RegExp(`\\b([A-Za-z_]\\w*)\\s*:\\s*(?:Add|GiveTask)\\s*\\(\\s*${escapeRegExp(binding)}\\b`);
    const index = lines.findIndex(line => pattern.test(line));
    return index >= 0 ? { Kind: 'lifecycle-owner', Line: index + 1 } : null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
