import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseStudioPayload(response, label = 'Studio operation') {
    if (!response) throw new Error(`${label} returned no response.`);
    if (response.error) throw new Error(response.error.message || `${label} returned an MCP error.`);

    const payload = response.result ?? response;
    const text = payload?.content?.find?.(entry => entry.type === 'text')?.text ??
        payload?.content?.[0]?.text ??
        payload;

    if (typeof text !== 'string') return text;
    let parsed = text;
    for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth += 1) {
        const trimmed = parsed.trim();
        if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"'))) {
            return parsed;
        }
        parsed = JSON.parse(trimmed);
    }
    return parsed;
}

export async function executeLuau(studioCommunicator, code, {
    label = 'Studio operation',
    timeoutMs = 20_000
} = {}) {
    if (!studioCommunicator?.isAlive?.()) {
        throw new Error('Roblox Studio MCP is unavailable.');
    }
    const response = await studioCommunicator.callTool('execute_luau', {
        code,
        datamodel_type: 'Edit'
    }, timeoutMs);
    return parseStudioPayload(response, label);
}

export function requireLiveStudio(studioCommunicator) {
    if (!studioCommunicator?.isAlive?.()) {
        throw new Error('This tool requires an active Roblox Studio MCP connection.');
    }
}

export function normalizePagination(args = {}, {
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = MAX_LIMIT
} = {}) {
    const offsetValue = args.offset ?? ((Number(args.page || 1) - 1) * Number(args.limit || defaultLimit));
    const offset = Number.isSafeInteger(Number(offsetValue)) && Number(offsetValue) >= 0
        ? Number(offsetValue)
        : 0;
    const requestedLimit = Number(args.limit ?? defaultLimit);
    const limit = Number.isSafeInteger(requestedLimit)
        ? Math.min(maxLimit, Math.max(1, requestedLimit))
        : defaultLimit;
    return { offset, limit };
}

export function paginate(items, args = {}, options = {}) {
    const { offset, limit } = normalizePagination(args, options);
    const page = items.slice(offset, offset + limit);
    return {
        Items: page,
        Page: {
            Offset: offset,
            Limit: limit,
            Returned: page.length,
            Total: items.length,
            NextOffset: offset + page.length < items.length ? offset + page.length : null
        }
    };
}

export function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

export function luaString(value) {
    return JSON.stringify(String(value ?? ''));
}

export function luaJson(value) {
    const json = JSON.stringify(value);
    for (let equalsCount = 0; equalsCount < 12; equalsCount += 1) {
        const equals = '='.repeat(equalsCount);
        const close = `]${equals}]`;
        if (!json.includes(close)) return `[${equals}[${json}]${equals}]`;
    }
    throw new Error('Unable to encode payload safely for Luau.');
}

export function sourceFingerprint(source) {
    const value = String(source ?? '');
    const bytes = Buffer.from(value, 'utf8');
    let hash = 0;
    for (const byte of bytes) {
        hash = (hash + byte) >>> 0;
        hash = (hash + (hash << 10)) >>> 0;
        hash = (hash ^ (hash >>> 6)) >>> 0;
    }
    hash = (hash + (hash << 3)) >>> 0;
    hash = (hash ^ (hash >>> 11)) >>> 0;
    hash = (hash + (hash << 15)) >>> 0;
    return `${bytes.length}:${hash.toString(16).padStart(8, '0')}`;
}

export function contentHash(value) {
    return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function summarizeItem(item) {
    return {
        Name: item.Name,
        ClassName: item.Class,
        Path: item.Path,
        Category: item.Category,
        SourceReadable: item.SourceReadable === true
    };
}

export function evidence(kind, path, detail, confidence = 'observed', line = undefined) {
    return {
        Kind: kind,
        Path: path,
        ...(line ? { Line: line } : {}),
        Detail: detail,
        Confidence: confidence
    };
}

export function lineNumberAt(source, index = 0) {
    return String(source ?? '').slice(0, Math.max(0, index)).split('\n').length;
}

export const LUAU_PATH_RESOLVER = `
local pathIndexes = {}

local function buildPathIndex(rootName)
    local existing = pathIndexes[rootName]
    if existing then return existing end
    local ok, root = pcall(function()
        return game:GetService(rootName)
    end)
    if not ok or not root then
        pathIndexes[rootName] = {}
        return pathIndexes[rootName]
    end

    local index = {[root:GetFullName()] = root}
    for _, descendant in root:GetDescendants() do
        local path = descendant:GetFullName()
        if index[path] ~= nil then
            index[path] = false
        else
            index[path] = descendant
        end
    end
    pathIndexes[rootName] = index
    return index
end

local function resolvePath(fullPath)
    if typeof(fullPath) ~= "string" or fullPath == "" then
        return nil
    end
    local rootName = string.match(fullPath, "^[^%.]+")
    if not rootName then return nil end
    local resolved = buildPathIndex(rootName)[fullPath]
    if typeof(resolved) ~= "Instance" then return nil end
    local aliveOk, isAlive = pcall(function()
        return resolved:IsDescendantOf(game)
    end)
    return aliveOk and isAlive and resolved or nil
end
`;

export const LUAU_SOURCE_FINGERPRINT = `
local function sourceFingerprint(source)
    local hash = 0
    for index = 1, #source do
        hash = bit32.band(hash + string.byte(source, index), 0xffffffff)
        hash = bit32.band(hash + bit32.lshift(hash, 10), 0xffffffff)
        hash = bit32.bxor(hash, bit32.rshift(hash, 6))
    end
    hash = bit32.band(hash + bit32.lshift(hash, 3), 0xffffffff)
    hash = bit32.bxor(hash, bit32.rshift(hash, 11))
    hash = bit32.band(hash + bit32.lshift(hash, 15), 0xffffffff)
    return tostring(#source) .. ":" .. string.format("%08x", hash)
end
`;

export async function fetchScriptSources(studioCommunicator, paths, {
    maxScripts = 100,
    maxSourceLength = 250_000,
    maxTotalSourceLength = 4_000_000,
    includePlaceIdentity = false
} = {}) {
    const uniquePaths = [...new Set((paths || []).map(String).filter(Boolean))].slice(0, maxScripts);
    if (uniquePaths.length === 0) return [];
    const recordsByPath = new Map();
    let cursor = { PathIndex: 1, SourceOffset: 0 };
    let placeIdentity = null;
    let totalReturnedSourceLength = 0;

    for (let page = 0; page < 500; page += 1) {
        const request = {
            paths: uniquePaths,
            pathIndex: cursor.PathIndex,
            sourceOffset: cursor.SourceOffset,
            maxSourceLength,
            maxPageBytes: 60_000
        };
        const code = `
local HttpService = game:GetService("HttpService")
${LUAU_PATH_RESOLVER}
${LUAU_SOURCE_FINGERPRINT}
local request = HttpService:JSONDecode(${luaJson(request)})
local output = {}
local encodedBytes = 200
local nextCursor = nil

for pathIndex = request.pathIndex, #request.paths do
    local path = request.paths[pathIndex]
    local instance = resolvePath(path)
    if instance and instance:IsA("LuaSourceContainer") then
        local ok, source = pcall(function()
            return instance.Source
        end)
        if ok then
            local targetLength = math.min(#source, request.maxSourceLength)
            while targetLength > 0 and utf8.len(string.sub(source, 1, targetLength)) == nil do
                targetLength -= 1
            end
            local sourceOffset = pathIndex == request.pathIndex and request.sourceOffset or 0
            local chunkLength = math.min(math.max(0, targetLength - sourceOffset), 24000)
            local function alignUtf8(length)
                while length > 0 and utf8.len(string.sub(source, sourceOffset + 1, sourceOffset + length)) == nil do
                    length -= 1
                end
                return length
            end
            chunkLength = alignUtf8(chunkLength)
            local function makeRecord(length)
                return {
                    Path = path,
                    Name = instance.Name,
                    ClassName = instance.ClassName,
                    SourceChunk = string.sub(source, sourceOffset + 1, sourceOffset + length),
                    SourceOffset = sourceOffset,
                    ChunkComplete = sourceOffset + length >= targetLength,
                    Truncated = #source > request.maxSourceLength,
                    SourceHash = sourceFingerprint(source),
                    SourceLength = #source,
                }
            end
            local record = makeRecord(chunkLength)
            local recordBytes = #HttpService:JSONEncode(record) + 1
            while encodedBytes + recordBytes > request.maxPageBytes and chunkLength > 1 do
                chunkLength = alignUtf8(math.max(1, math.floor(chunkLength / 2)))
                record = makeRecord(chunkLength)
                recordBytes = #HttpService:JSONEncode(record) + 1
            end
            if encodedBytes + recordBytes > request.maxPageBytes and #output > 0 then
                nextCursor = {PathIndex = pathIndex, SourceOffset = sourceOffset}
                break
            end
            table.insert(output, record)
            encodedBytes += recordBytes
            if not record.ChunkComplete then
                nextCursor = {PathIndex = pathIndex, SourceOffset = sourceOffset + chunkLength}
                break
            end
        end
    end
end
local placeIdentity = {
    Name = game.Name,
    PlaceId = game.PlaceId,
    GameId = game.GameId,
    CreatorId = game.CreatorId,
}
return HttpService:JSONEncode({
    Records = output,
    Next = nextCursor,
    PlaceIdentity = placeIdentity,
    EncodedBytes = encodedBytes,
})
`;
        const result = await executeLuau(studioCommunicator, code, {
            label: 'Source retrieval',
            timeoutMs: 30_000
        });
        if (Array.isArray(result)) {
            throw new Error('Source retrieval returned an obsolete unbound response shape.');
        }
        if (result?.Error) throw new Error(result.Error);
        if (!result || !Array.isArray(result.Records) || !result.PlaceIdentity) {
            throw new Error('Source retrieval returned an unexpected live Studio payload.');
        }
        const identityKey = JSON.stringify({
            Name: result.PlaceIdentity.Name,
            PlaceId: Number(result.PlaceIdentity.PlaceId || 0),
            GameId: Number(result.PlaceIdentity.GameId || 0),
            CreatorId: Number(result.PlaceIdentity.CreatorId || 0)
        });
        if (placeIdentity === null) {
            placeIdentity = result.PlaceIdentity;
        } else {
            const expectedIdentityKey = JSON.stringify({
                Name: placeIdentity.Name,
                PlaceId: Number(placeIdentity.PlaceId || 0),
                GameId: Number(placeIdentity.GameId || 0),
                CreatorId: Number(placeIdentity.CreatorId || 0)
            });
            if (identityKey !== expectedIdentityKey) {
                throw new Error('The active Studio place changed during source retrieval.');
            }
        }
        for (const chunk of result.Records) {
            if (!chunk || typeof chunk.Path !== 'string' || typeof chunk.SourceChunk !== 'string') {
                throw new Error('Source retrieval returned a malformed source chunk.');
            }
            let record = recordsByPath.get(chunk.Path);
            if (!record) {
                if (Number(chunk.SourceOffset) !== 0) {
                    throw new Error(`Source retrieval started '${chunk.Path}' at a non-zero cursor.`);
                }
                record = {
                    Path: chunk.Path,
                    Name: chunk.Name,
                    ClassName: chunk.ClassName,
                    Source: '',
                    Truncated: chunk.Truncated === true,
                    SourceHash: chunk.SourceHash,
                    SourceLength: Number(chunk.SourceLength || 0)
                };
                recordsByPath.set(chunk.Path, record);
            } else if (record.SourceHash !== chunk.SourceHash ||
                record.SourceLength !== Number(chunk.SourceLength || 0) ||
                record.ClassName !== chunk.ClassName ||
                record.Name !== chunk.Name ||
                record.Truncated !== (chunk.Truncated === true)) {
                throw new Error(`The source for '${chunk.Path}' changed during paged retrieval.`);
            }
            if (Number(chunk.SourceOffset) !== Buffer.byteLength(record.Source, 'utf8')) {
                throw new Error(`Source retrieval returned a discontinuous chunk for '${chunk.Path}'.`);
            }
            record.Source += chunk.SourceChunk;
            totalReturnedSourceLength += Buffer.byteLength(chunk.SourceChunk, 'utf8');
            if (totalReturnedSourceLength > maxTotalSourceLength) {
                throw new Error(`Cumulative source response exceeds the ${maxTotalSourceLength}-byte limit.`);
            }
        }
        if (result.Next === null || result.Next === undefined) break;
        const nextPathIndex = Number(result.Next.PathIndex);
        const nextSourceOffset = Number(result.Next.SourceOffset);
        if (!Number.isSafeInteger(nextPathIndex) || nextPathIndex < 1 ||
            nextPathIndex > uniquePaths.length ||
            !Number.isSafeInteger(nextSourceOffset) || nextSourceOffset < 0 ||
            (nextPathIndex > cursor.PathIndex && nextSourceOffset !== 0) ||
            (nextPathIndex === cursor.PathIndex && nextSourceOffset <= cursor.SourceOffset)) {
            throw new Error('Source retrieval returned a non-advancing cursor.');
        }
        cursor = { PathIndex: nextPathIndex, SourceOffset: nextSourceOffset };
        if (page === 499) throw new Error('Source retrieval exceeded its bounded page limit.');
    }
    const records = uniquePaths.map(path => recordsByPath.get(path)).filter(Boolean);
    return includePlaceIdentity ? { Records: records, PlaceIdentity: placeIdentity } : records;
}

export async function fetchPlaceIdentity(studioCommunicator) {
    return executeLuau(studioCommunicator, `
local HttpService = game:GetService("HttpService")
return HttpService:JSONEncode({
    Name = game.Name,
    PlaceId = game.PlaceId,
    GameId = game.GameId,
    CreatorId = game.CreatorId,
})
`, { label: 'Transaction place identity check' });
}

export function stableSortFindings(findings) {
    return findings.sort((left, right) =>
        String(left.Path || '').localeCompare(String(right.Path || '')) ||
        Number(left.Line || 0) - Number(right.Line || 0) ||
        String(left.Rule || '').localeCompare(String(right.Rule || ''))
    );
}
