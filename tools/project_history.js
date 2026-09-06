import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as analyzeProject from './analyze_project.js';
import { cacheMetadata, loadBrain, placeIdentitiesMatch } from './brain_store.js';
import {
    clampInteger,
    fetchScriptSources,
    normalizeOutputOptions,
    stringifyBounded
} from './studio_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HISTORY_PATH = process.env.ROBLOX_SUPER_MCP_HISTORY_PATH ||
    path.join(__dirname, '..', 'project_history.json');
export const SOURCE_CACHE_DIRECTORY = process.env.ROBLOX_SUPER_MCP_SOURCE_CACHE_PATH ||
    path.join(__dirname, '..', '.snapshot-cache');

export async function saveSnapshot(args = {}, studioCommunicator) {
    const refresh = await refreshIndex(args, studioCommunicator);
    if (refresh?.error) return JSON.stringify({ Status: 'Snapshot Failed', ...refresh }, null, 2);
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const history = loadHistory();
    const snapshot = makeSnapshot(loaded.brain, args, history.CurrentVersion);
    const sourceBaseline = await captureSourceBaseline(snapshot, loaded.brain, studioCommunicator);
    snapshot.SourceBaseline = sourceBaseline;
    history.Snapshots.push(snapshot);
    history.Snapshots = history.Snapshots.slice(-20);
    const versionChanged = Boolean(history.CurrentVersion && snapshot.Version && history.CurrentVersion !== snapshot.Version);
    if (snapshot.Version) history.CurrentVersion = snapshot.Version;
    saveHistory(history);
    pruneSourceCache(versionChanged && sourceBaseline.Complete
        ? new Set([snapshot.Id])
        : new Set(history.Snapshots.map(item => item.Id)));
    return JSON.stringify({
        Status: 'Project Snapshot Saved',
        SnapshotId: snapshot.Id,
        Label: snapshot.Label,
        Version: snapshot.Version,
        CreatedAt: snapshot.CreatedAt,
        IndexedItems: snapshot.Items.length,
        SourceBaseline: sourceBaseline,
        RetainedSnapshots: history.Snapshots.length
    }, null, 2);
}

export async function recordChange(args = {}) {
    const change = String(args.change || '').trim();
    if (!change) return JSON.stringify({ error: 'Please provide a concise change description.' });
    const history = loadHistory();
    const entry = {
        Id: randomUUID(),
        RecordedAt: new Date().toISOString(),
        Importance: ['breaking', 'important', 'normal', 'minor'].includes(args.importance)
            ? args.importance
            : 'normal',
        Kind: ['added', 'removed', 'changed', 'adjusted', 'fixed', 'internal'].includes(args.kind)
            ? args.kind
            : 'changed',
        Change: change.slice(0, 2_000),
        Paths: [...new Set((Array.isArray(args.paths) ? args.paths : []).map(String).filter(Boolean))].slice(0, 20),
        Version: String(args.version || history.CurrentVersion || '').trim() || null
    };
    history.Changes.push(entry);
    history.Changes = history.Changes.slice(-500);
    if (args.version) history.CurrentVersion = String(args.version).trim();
    saveHistory(history);
    return JSON.stringify({ Status: 'Project Change Recorded', Entry: entry }, null, 2);
}

export async function diffProject(args = {}, studioCommunicator) {
    const refresh = await refreshIndex(args, studioCommunicator);
    if (refresh?.error) return JSON.stringify({ Status: 'Project Diff Failed', ...refresh }, null, 2);
    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const history = loadHistory();
    const baseline = args.snapshot_id
        ? history.Snapshots.find(snapshot => snapshot.Id === args.snapshot_id)
        : history.Snapshots.at(-1);
    if (!baseline) {
        return JSON.stringify({
            Status: 'No Baseline Snapshot',
            SuggestedAction: 'Call save_project_snapshot before the work session, then refresh_project and diff_project afterward.'
        }, null, 2);
    }
    if (!placeIdentitiesMatch(baseline.PlaceIdentity, loaded.brain.PlaceIdentity)) {
        return JSON.stringify({
            Status: 'Snapshot Rejected',
            PlaceMismatch: true,
            BaselinePlaceIdentity: baseline.PlaceIdentity,
            CurrentPlaceIdentity: loaded.brain.PlaceIdentity
        }, null, 2);
    }

    const output = normalizeOutputOptions(args);
    const diff = compareProjectItems(baseline.Items, loaded.brain.AllItems);
    const sourceDiff = await compareLiveSources(baseline, diff, args, output, studioCommunicator);
    const since = Date.parse(baseline.CreatedAt);
    const recordedChanges = args.include_recorded_changes === false
        ? []
        : history.Changes.filter(entry => Date.parse(entry.RecordedAt) >= since);
    const result = {
        Status: 'Project Diff Ready',
        Baseline: { Id: baseline.Id, Label: baseline.Label, Version: baseline.Version, CreatedAt: baseline.CreatedAt },
        Current: { Version: history.CurrentVersion || null, ScannedAt: loaded.brain.ScannedAt || null },
        Summary: {
            ...diff.Summary,
            ...(sourceDiff.Complete ? {
                LinesAdded: sourceDiff.LinesAdded,
                LinesRemoved: sourceDiff.LinesRemoved,
                LineCountEvidence: 'exact-source-diff'
            } : { LineCountEvidence: 'indexed-line-count-estimate' })
        },
        FileDiffs: sourceDiff.Files,
        SourceDiff: {
            Complete: sourceDiff.Complete,
            Reason: sourceDiff.Reason,
            FilesCompared: sourceDiff.FilesCompared,
            ReturnedFiles: sourceDiff.Files.length,
            ChangedLinesTruncated: sourceDiff.ChangedLinesTruncated
        },
        Added: limitAndShape(diff.Added, output),
        Removed: limitAndShape(diff.Removed, output),
        Moved: limitAndShape(diff.Moved, output),
        Changed: limitAndShape(diff.Changed, output),
        RecordedChanges: recordedChanges.slice(-output.maxResults),
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema),
        EvidenceQuality: 'full source stays in the local cache; only changed line hunks and recorded notes are returned'
    };
    return stringifyBounded(result, output.maxChars, [
        'FileDiffs', 'Added', 'Removed', 'Moved', 'Changed', 'RecordedChanges'
    ]);
}

export function compareProjectItems(beforeItems, afterItems) {
    const before = beforeItems.map(compactItem);
    const after = afterItems.map(compactItem);
    const oldByPath = new Map(before.map(item => [item.Path, item]));
    const newByPath = new Map(after.map(item => [item.Path, item]));
    let added = after.filter(item => !oldByPath.has(item.Path));
    let removed = before.filter(item => !newByPath.has(item.Path));
    const moved = [];

    for (const oldItem of [...removed]) {
        if (!oldItem.SourceHash) continue;
        const matches = added.filter(item => item.Class === oldItem.Class && item.SourceHash === oldItem.SourceHash);
        if (matches.length !== 1) continue;
        const newItem = matches[0];
        moved.push({ From: oldItem.Path, To: newItem.Path, ClassName: newItem.Class });
        removed = removed.filter(item => item !== oldItem);
        added = added.filter(item => item !== newItem);
    }

    const changed = after.flatMap(item => {
        const old = oldByPath.get(item.Path);
        if (!old || itemSignature(old) === itemSignature(item)) return [];
        return [{
            Path: item.Path,
            ClassName: item.Class,
            LinesBefore: old.SourceLines,
            LinesAfter: item.SourceLines,
            LinesDelta: item.SourceLines - old.SourceLines,
            FunctionsAdded: difference(item.Functions, old.Functions),
            FunctionsRemoved: difference(old.Functions, item.Functions),
            CallsAdded: difference(item.Calls, old.Calls),
            CallsRemoved: difference(old.Calls, item.Calls),
            DependenciesAdded: difference(item.Requires, old.Requires),
            DependenciesRemoved: difference(old.Requires, item.Requires),
            RemotesAdded: difference(remoteKeys(item.RemoteUsage), remoteKeys(old.RemoteUsage)),
            RemotesRemoved: difference(remoteKeys(old.RemoteUsage), remoteKeys(item.RemoteUsage))
        }];
    });
    const positiveLines = changed.reduce((total, item) => total + Math.max(0, item.LinesDelta), 0);
    const negativeLines = changed.reduce((total, item) => total + Math.max(0, -item.LinesDelta), 0);
    return {
        Summary: {
            Added: added.length,
            Removed: removed.length,
            Moved: moved.length,
            Changed: changed.length,
            LinesAdded: added.reduce((total, item) => total + item.SourceLines, positiveLines),
            LinesRemoved: removed.reduce((total, item) => total + item.SourceLines, negativeLines)
        },
        Added: added,
        Removed: removed,
        Moved: moved,
        Changed: changed
    };
}

function loadHistory() {
    if (!fs.existsSync(HISTORY_PATH)) return { SchemaVersion: 1, CurrentVersion: null, Snapshots: [], Changes: [] };
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return {
        SchemaVersion: 1,
        CurrentVersion: parsed.CurrentVersion || null,
        Snapshots: Array.isArray(parsed.Snapshots) ? parsed.Snapshots : [],
        Changes: Array.isArray(parsed.Changes) ? parsed.Changes : []
    };
}

function saveHistory(history) {
    const temporaryPath = `${HISTORY_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(history, null, 2));
        fs.renameSync(temporaryPath, HISTORY_PATH);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

function makeSnapshot(brain, args, currentVersion = null) {
    return {
        Id: randomUUID(),
        Label: String(args.label || '').trim() || `Snapshot ${new Date().toISOString()}`,
        Version: String(args.version || currentVersion || '').trim() || null,
        CreatedAt: new Date().toISOString(),
        PlaceIdentity: brain.PlaceIdentity,
        Items: brain.AllItems.map(compactItem)
    };
}

function compactItem(item) {
    return {
        Name: String(item.Name || ''),
        Class: String(item.Class || item.ClassName || ''),
        Path: String(item.Path || ''),
        Category: String(item.Category || ''),
        SourceHash: String(item.SourceHash || ''),
        SourceLines: Number(item.SourceLines || 0),
        Functions: [...(item.Functions || [])],
        Calls: [...(item.Calls || [])],
        Requires: [...(item.Requires || [])],
        RemoteUsage: [...(item.RemoteUsage || [])]
    };
}

function itemSignature(item) {
    return JSON.stringify([
        item.Class, item.SourceHash, item.Functions, item.Calls, item.Requires, remoteKeys(item.RemoteUsage)
    ]);
}

function remoteKeys(records) {
    return records.map(record => `${record.Name}:${record.Method}`).sort();
}

function difference(left, right) {
    const excluded = new Set(right);
    return left.filter(value => !excluded.has(value));
}

function limitAndShape(items, output) {
    return items.slice(0, output.maxResults).map(item => output.detail === 'compact'
        ? (item.Path ? { Path: item.Path } : { From: item.From, To: item.To })
        : output.detail === 'normal' && item.Path
            ? Object.fromEntries(Object.entries(item).filter(([, value]) => !Array.isArray(value) || value.length > 0))
            : item);
}

async function refreshIndex(args, studioCommunicator) {
    if (args.refresh === false || !studioCommunicator?.isAlive?.()) return null;
    const result = JSON.parse(await analyzeProject.refresh({}, studioCommunicator));
    if (result.LiveScanError || ['Scan Failed', 'Cached Brain Rejected', 'Live Scan Incomplete'].includes(result.Status)) {
        return {
            error: result.LiveScanError || result.Error || result.Status,
            SuggestedAction: 'Keep the intended Studio place connected and retry.'
        };
    }
    return result;
}

async function captureSourceBaseline(snapshot, brain, studioCommunicator) {
    if (!studioCommunicator?.isAlive?.()) {
        return { Captured: false, Reason: 'Live Studio is unavailable; metadata-only snapshot saved.' };
    }
    const paths = brain.AllItems
        .filter(item => ['Script', 'LocalScript', 'ModuleScript'].includes(item.Class) && item.SourceReadable === true)
        .map(item => item.Path);
    const records = await fetchScriptSources(studioCommunicator, paths, {
        maxScripts: paths.length,
        maxSourceLength: 1_000_000,
        maxTotalSourceLength: 32_000_000
    });
    const payload = {
        SchemaVersion: 1,
        SnapshotId: snapshot.Id,
        Version: snapshot.Version,
        CreatedAt: snapshot.CreatedAt,
        PlaceIdentity: snapshot.PlaceIdentity,
        Sources: records
    };
    const bytes = saveSourceCache(snapshot.Id, payload);
    const missingScriptCount = Math.max(0, paths.length - records.length);
    const truncatedScriptCount = records.filter(record => record.Truncated).length;
    return {
        Captured: true,
        Complete: missingScriptCount === 0 && truncatedScriptCount === 0,
        ScriptCount: records.length,
        MissingScriptCount: missingScriptCount,
        TruncatedScriptCount: truncatedScriptCount,
        Bytes: bytes
    };
}

async function compareLiveSources(baseline, structuralDiff, args, output, studioCommunicator) {
    const cached = loadSourceCache(baseline.Id);
    if (!cached) {
        return sourceDiffUnavailable('The baseline predates source snapshots or its temporary cache was rotated.');
    }
    if (!placeIdentitiesMatch(cached.PlaceIdentity, baseline.PlaceIdentity)) {
        return sourceDiffUnavailable('The cached source baseline does not match the snapshot place.');
    }
    if (!studioCommunicator?.isAlive?.()) {
        return sourceDiffUnavailable('Live Studio is required to read current source privately.');
    }

    const changedScripts = structuralDiff.Changed.filter(item =>
        ['Script', 'LocalScript', 'ModuleScript'].includes(item.ClassName)
    );
    const changedPaths = changedScripts.map(item => item.Path);
    const addedPaths = structuralDiff.Added
        .filter(item => ['Script', 'LocalScript', 'ModuleScript'].includes(item.Class))
        .map(item => item.Path);
    const currentPaths = [...new Set([...changedPaths, ...addedPaths])];
    const currentRecords = currentPaths.length === 0 ? [] : await fetchScriptSources(studioCommunicator, currentPaths, {
        maxScripts: currentPaths.length,
        maxSourceLength: 1_000_000,
        maxTotalSourceLength: 32_000_000
    });
    const oldByPath = new Map((cached.Sources || []).map(record => [record.Path, record]));
    const currentByPath = new Map(currentRecords.map(record => [record.Path, record]));
    const requestedPaths = new Set((Array.isArray(args.paths) ? args.paths : []).map(String));
    const maxDiffLines = clampInteger(args.max_diff_lines, {
        compact: 20,
        normal: 100,
        deep: 1_000
    }[output.detail], 1, 10_000);
    const specs = [
        ...changedScripts.map(item => ({ Status: 'changed', Path: item.Path })),
        ...structuralDiff.Added
            .filter(item => ['Script', 'LocalScript', 'ModuleScript'].includes(item.Class))
            .map(item => ({ Status: 'added', Path: item.Path })),
        ...structuralDiff.Removed
            .filter(item => ['Script', 'LocalScript', 'ModuleScript'].includes(item.Class))
            .map(item => ({ Status: 'removed', Path: item.Path })),
        ...structuralDiff.Moved.map(item => ({ Status: 'moved', Path: item.To, PreviousPath: item.From }))
    ].filter(item => requestedPaths.size === 0 || requestedPaths.has(item.Path) || requestedPaths.has(item.PreviousPath));

    const files = specs.slice(0, output.maxResults).map(spec => {
        if (spec.Status === 'moved') {
            return {
                Path: spec.Path,
                PreviousPath: spec.PreviousPath,
                Status: 'moved',
                Summary: `${spec.PreviousPath} -> ${spec.Path} [+ 0, - 0]`,
                LinesAdded: 0,
                LinesRemoved: 0,
                Hunks: []
            };
        }
        const beforeRecord = oldByPath.get(spec.Path);
        const afterRecord = currentByPath.get(spec.Path);
        if ((spec.Status !== 'added' && !beforeRecord) || (spec.Status !== 'removed' && !afterRecord)) {
            return {
                Path: spec.Path,
                Status: spec.Status,
                SourceAvailable: false,
                Reason: 'The required private source was not available.'
            };
        }
        return createSourceDiff(
            spec.Path,
            spec.Status === 'added' ? '' : beforeRecord.Source,
            spec.Status === 'removed' ? '' : afterRecord.Source,
            { status: spec.Status, maxDiffLines }
        );
    });
    const comparableFiles = files.filter(file => file.SourceAvailable !== false);
    return {
        Complete: specs.length <= output.maxResults && comparableFiles.length === files.length &&
            cached.Sources.every(record => record.Truncated !== true) &&
            currentRecords.every(record => record.Truncated !== true),
        Reason: specs.length > output.maxResults ? 'More changed files exist than max_results allows.' : null,
        Files: files,
        FilesCompared: comparableFiles.length,
        LinesAdded: comparableFiles.reduce((total, file) => total + file.LinesAdded, 0),
        LinesRemoved: comparableFiles.reduce((total, file) => total + file.LinesRemoved, 0),
        ChangedLinesTruncated: comparableFiles.reduce((total, file) => total + file.TruncatedChangedLines, 0)
    };
}

function sourceDiffUnavailable(reason) {
    return {
        Complete: false,
        Reason: reason,
        Files: [],
        FilesCompared: 0,
        LinesAdded: 0,
        LinesRemoved: 0,
        ChangedLinesTruncated: 0
    };
}

export function createSourceDiff(pathName, beforeSource, afterSource, {
    status = 'changed',
    maxDiffLines = 100
} = {}) {
    const operations = diffLines(beforeSource, afterSource);
    const changed = operations.filter(operation => operation.Type !== 'equal');
    const hunks = [];
    let current = null;
    for (const operation of operations) {
        if (operation.Type === 'equal') {
            current = null;
            continue;
        }
        if (!current) {
            current = { OldStart: operation.OldLine, NewStart: operation.NewLine, Lines: [] };
            hunks.push(current);
        }
        const lineNumber = operation.Type === 'added' ? operation.NewLine : operation.OldLine;
        current.Lines.push(`${operation.Type === 'added' ? '+' : '-'}${lineNumber} ${operation.Text}`);
    }
    let remaining = Math.max(1, Number(maxDiffLines) || 100);
    const visibleHunks = [];
    for (const hunk of hunks) {
        if (remaining <= 0) break;
        const lines = hunk.Lines.slice(0, remaining);
        if (lines.length > 0) visibleHunks.push({ ...hunk, Lines: lines });
        remaining -= lines.length;
    }
    const linesAdded = changed.filter(operation => operation.Type === 'added').length;
    const linesRemoved = changed.filter(operation => operation.Type === 'removed').length;
    return {
        Path: pathName,
        Status: status,
        SourceAvailable: true,
        Summary: `${pathName} [+ ${linesAdded}, - ${linesRemoved}]`,
        LinesAdded: linesAdded,
        LinesRemoved: linesRemoved,
        Hunks: visibleHunks,
        TruncatedChangedLines: Math.max(0, changed.length - (Number(maxDiffLines) || 100))
    };
}

export function diffLines(beforeSource, afterSource) {
    const before = splitSourceLines(beforeSource);
    const after = splitSourceLines(afterSource);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
        before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1;
    const middleBefore = before.slice(prefix, before.length - suffix);
    const middleAfter = after.slice(prefix, after.length - suffix);
    const operations = [
        ...before.slice(0, prefix).map(Text => ({ Type: 'equal', Text })),
        ...myersDiff(middleBefore, middleAfter),
        ...before.slice(before.length - suffix).map(Text => ({ Type: 'equal', Text }))
    ];
    let oldLine = 1;
    let newLine = 1;
    return operations.map(operation => {
        const numbered = { ...operation, OldLine: oldLine, NewLine: newLine };
        if (operation.Type !== 'added') oldLine += 1;
        if (operation.Type !== 'removed') newLine += 1;
        return numbered;
    });
}

function myersDiff(before, after) {
    if (before.length === 0) return after.map(Text => ({ Type: 'added', Text }));
    if (after.length === 0) return before.map(Text => ({ Type: 'removed', Text }));
    const maximumDistance = Math.min(before.length + after.length, 2_000);
    let frontier = new Map([[1, 0]]);
    const trace = [];
    for (let distance = 0; distance <= maximumDistance; distance += 1) {
        trace.push(new Map(frontier));
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            const down = frontier.get(diagonal + 1) ?? -1;
            const right = frontier.get(diagonal - 1) ?? -1;
            let x = diagonal === -distance || (diagonal !== distance && right < down)
                ? Math.max(0, down)
                : right + 1;
            let y = x - diagonal;
            while (x < before.length && y < after.length && before[x] === after[y]) {
                x += 1;
                y += 1;
            }
            frontier.set(diagonal, x);
            if (x >= before.length && y >= after.length) return backtrackDiff(trace, before, after);
        }
    }
    // ponytail: cap pathological rewrites; treating the middle as one replacement keeps memory bounded.
    return [
        ...before.map(Text => ({ Type: 'removed', Text })),
        ...after.map(Text => ({ Type: 'added', Text }))
    ];
}

function backtrackDiff(trace, before, after) {
    let x = before.length;
    let y = after.length;
    const operations = [];
    for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
        const frontier = trace[distance];
        const diagonal = x - y;
        const down = frontier.get(diagonal + 1) ?? -1;
        const right = frontier.get(diagonal - 1) ?? -1;
        const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
            ? diagonal + 1
            : diagonal - 1;
        const previousX = Math.max(0, frontier.get(previousDiagonal) ?? 0);
        const previousY = previousX - previousDiagonal;
        while (x > previousX && y > previousY) {
            operations.push({ Type: 'equal', Text: before[x - 1] });
            x -= 1;
            y -= 1;
        }
        if (distance === 0) break;
        if (x === previousX) {
            operations.push({ Type: 'added', Text: after[y - 1] });
            y -= 1;
        } else {
            operations.push({ Type: 'removed', Text: before[x - 1] });
            x -= 1;
        }
    }
    return operations.reverse();
}

function splitSourceLines(source) {
    const normalized = String(source || '').replaceAll('\r\n', '\n');
    return normalized === '' ? [] : normalized.split('\n');
}

function sourceCachePath(snapshotId) {
    return path.join(SOURCE_CACHE_DIRECTORY, `${String(snapshotId).replace(/[^a-zA-Z0-9-]/g, '')}.json`);
}

function saveSourceCache(snapshotId, payload) {
    fs.mkdirSync(SOURCE_CACHE_DIRECTORY, { recursive: true });
    const target = sourceCachePath(snapshotId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const text = JSON.stringify(payload);
    try {
        fs.writeFileSync(temporary, text);
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return Buffer.byteLength(text, 'utf8');
}

function loadSourceCache(snapshotId) {
    const target = sourceCachePath(snapshotId);
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed?.SchemaVersion === 1 && Array.isArray(parsed.Sources) ? parsed : null;
}

function pruneSourceCache(retainedSnapshotIds) {
    if (!fs.existsSync(SOURCE_CACHE_DIRECTORY)) return;
    for (const entry of fs.readdirSync(SOURCE_CACHE_DIRECTORY, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const snapshotId = entry.name.slice(0, -5);
        if (!retainedSnapshotIds.has(snapshotId)) fs.unlinkSync(path.join(SOURCE_CACHE_DIRECTORY, entry.name));
    }
}
