const STOP_WORDS = new Set([
    'a', 'an', 'and', 'code', 'component', 'feature', 'for', 'in', 'of', 'on',
    'script', 'system', 'systems', 'the', 'to', 'with'
]);

const IRREGULAR_ROOTS = new Map([
    ['currencies', 'currency'],
    ['data', 'data'],
    ['indices', 'index'],
    ['inventories', 'inventory'],
    ['traded', 'trade'],
    ['trades', 'trade'],
    ['trading', 'trade']
]);

function splitWords(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function rootWord(word) {
    const irregular = IRREGULAR_ROOTS.get(word);
    if (irregular) return irregular;

    if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (word.length > 5 && word.endsWith('ing')) {
        const base = word.slice(0, -3);
        if (base.endsWith('d') || base.endsWith('t')) return `${base}e`;
        return base;
    }
    if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
    return word;
}

export function tokenize(value, { keepStopWords = false } = {}) {
    const roots = splitWords(value).map(rootWord);
    const filtered = keepStopWords ? roots : roots.filter(word => !STOP_WORDS.has(word));
    return [...new Set(filtered)];
}

function itemText(item) {
    return [
        item.Name,
        item.Parent,
        item.Path || item.FullName,
        item.Class || item.ClassName,
        item.Category,
        ...(item.SearchTerms || []),
        ...(item.Requires || []),
        ...(item.ServicesUsed || []),
        ...(item.Attributes || []),
        ...(item.AttributeUsage || []).flatMap(record => [record.Name, record.Method]),
        ...(item.Functions || []),
        ...(item.Calls || []),
        ...(item.RemoteUsage || []).flatMap(record => [record.Name, record.Method]),
        ...(item.DataStoreUsage || []).flatMap(record => [record.Name, record.Method])
    ].filter(Boolean).join(' ');
}

export function matchEvidence(item, query) {
    const tokens = tokenize(query);
    const fields = [
        ['name', [item.Name]],
        ['path', [item.Path || item.FullName]],
        ['functions', item.Functions || []],
        ['calls', item.Calls || []],
        ['dependencies', item.Requires || []],
        ['services', item.ServicesUsed || []],
        ['attributes', item.Attributes || []],
        ['remotes', (item.RemoteUsage || []).flatMap(record => [record.Name, record.Method])],
        ['datastores', (item.DataStoreUsage || []).flatMap(record => [record.Name, record.Method])],
        ['indexed-identifiers', item.SearchTerms || []]
    ];
    return fields.flatMap(([field, values]) => {
        const fieldTokens = new Set(tokenize(values.join(' '), { keepStopWords: true }));
        const matched = tokens.filter(token => fieldTokens.has(token));
        return matched.length > 0 ? [{ Field: field, MatchedTerms: matched }] : [];
    });
}

export function scoreItem(item, query) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return null;

    const nameTokens = new Set(tokenize(item.Name, { keepStopWords: true }));
    const pathTokens = new Set(tokenize(item.Path || item.FullName, { keepStopWords: true }));
    const metadataTokens = new Set(tokenize(itemText(item), { keepStopWords: true }));
    const matchedTokens = [];
    let score = 0;

    for (const token of queryTokens) {
        if (nameTokens.has(token)) {
            score += 8;
            matchedTokens.push(token);
        } else if (pathTokens.has(token)) {
            score += 4;
            matchedTokens.push(token);
        } else if (metadataTokens.has(token)) {
            score += 2;
            matchedTokens.push(token);
        }
    }

    if (matchedTokens.length === 0) return null;
    score += Math.round((matchedTokens.length / queryTokens.length) * 5);

    return {
        score,
        matchedTokens,
        queryTokens
    };
}

export function findRankedItems(items, query, limit = 50) {
    return items
        .map(item => ({ item, match: scoreItem(item, query) }))
        .filter(result => result.match !== null)
        .sort((left, right) =>
            right.match.score - left.match.score ||
            String(left.item.Name || '').localeCompare(String(right.item.Name || ''))
        )
        .slice(0, limit);
}
