import { cacheMetadata, loadBrain } from './brain_store.js';
import { normalizeOutputOptions, stringifyBounded } from './studio_utils.js';

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);

export async function run(args = {}) {
    const symbol = String(args.symbol || '').trim();
    if (!symbol) return JSON.stringify({ error: 'Please provide a symbol.' });

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);

    const mode = ['definition', 'references', 'callers', 'callees', 'graph'].includes(args.mode)
        ? args.mode
        : 'references';
    const output = normalizeOutputOptions(args);
    const scripts = loaded.brain.AllItems.filter(item => SCRIPT_CLASSES.has(item.Class));
    const definitions = scripts.flatMap(item => definitionRecords(item)
        .filter(record => symbolMatches(record.Name, symbol))
        .map(record => ({ Path: item.Path, ClassName: item.Class, Symbol: record.Name, Line: record.Line || null })));
    const callers = scripts.flatMap(item => {
        const sites = callRecords(item).filter(record => symbolMatches(record.Name, symbol));
        return sites.length ? [{
            Path: item.Path,
            ClassName: item.Class,
            Lines: [...new Set(sites.map(site => site.Line).filter(Boolean))],
            Occurrences: sites.length
        }] : [];
    });
    const definitionPaths = new Set(definitions.map(record => record.Path));
    const callees = scripts
        .filter(item => definitionPaths.has(item.Path))
        .flatMap(item => callRecords(item).map(site => ({
            FromPath: item.Path,
            Symbol: site.Name,
            Line: site.Line || null,
            DefinitionPaths: scripts
                .filter(candidate => definitionRecords(candidate).some(record => symbolMatches(record.Name, site.Name)))
                .map(candidate => candidate.Path)
        })))
        .filter((record, index, all) => all.findIndex(candidate =>
            candidate.FromPath === record.FromPath && candidate.Symbol === record.Symbol && candidate.Line === record.Line
        ) === index);
    const references = scripts.filter(item =>
        definitionRecords(item).some(record => symbolMatches(record.Name, symbol)) ||
        callRecords(item).some(record => symbolMatches(record.Name, symbol)) ||
        item.Requires.some(name => symbolMatches(name, symbol)) ||
        item.SearchTerms.some(name => symbolMatches(name, symbol))
    ).map(item => ({
        Path: item.Path,
        ClassName: item.Class,
        Defines: definitionRecords(item).filter(record => symbolMatches(record.Name, symbol)),
        Calls: callRecords(item).filter(record => symbolMatches(record.Name, symbol)),
        Requires: item.Requires.filter(name => symbolMatches(name, symbol))
    }));

    const selected = {
        definition: { Definitions: definitions },
        references: { References: references },
        callers: { Callers: callers },
        callees: { Callees: callees },
        graph: {
            Definitions: definitions,
            Callers: callers,
            Callees: callees,
            Edges: [
                ...callers.map(caller => ({ FromPath: caller.Path, ToSymbol: symbol, Lines: caller.Lines })),
                ...callees.map(callee => ({
                    FromPath: callee.FromPath,
                    ToSymbol: callee.Symbol,
                    Line: callee.Line,
                    DefinitionPaths: callee.DefinitionPaths
                }))
            ]
        }
    }[mode];
    const result = {
        Status: 'Symbol Index Ready',
        Symbol: symbol,
        Mode: mode,
        EvidenceQuality: 'lexically-masked-regex; calls are script-scoped, not function-scoped',
        ...Object.fromEntries(Object.entries(selected).map(([key, value]) => [
            key,
            value.slice(0, output.maxResults).map(record => output.detail === 'compact' ? compact(record) : record)
        ])),
        Cache: cacheMetadata(loaded.brain, loaded.staleSchema)
    };
    return stringifyBounded(result, output.maxChars, Object.keys(selected));
}

function definitionRecords(item) {
    return item.FunctionDefinitions.length > 0
        ? item.FunctionDefinitions
        : item.Functions.map(Name => ({ Name, Line: null }));
}

function callRecords(item) {
    return item.CallSites.length > 0
        ? item.CallSites
        : item.Calls.map(Name => ({ Name, Line: null }));
}

function symbolMatches(candidate, query) {
    const left = String(candidate || '').toLowerCase();
    const right = String(query || '').toLowerCase();
    if (/[.:]/.test(left) && /[.:]/.test(right)) {
        return left.replaceAll(':', '.') === right.replaceAll(':', '.');
    }
    return left === right || leaf(left) === leaf(right);
}

function leaf(value) {
    return String(value).split(/[.:]/).pop();
}

function compact(record) {
    return Object.fromEntries(Object.entries(record).filter(([key]) =>
        ['Path', 'Symbol', 'Line', 'Occurrences', 'FromPath', 'ToSymbol'].includes(key)
    ));
}
