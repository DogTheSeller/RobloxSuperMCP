import {
    BRAIN_SCHEMA_VERSION,
    cacheMetadata,
    loadBrain,
    placeIdentitiesMatch,
    saveBrain
} from './brain_store.js';
import { executeLuau, luaJson, parseStudioPayload } from './studio_utils.js';

export const LUAU_SCANNER_SCRIPT = `
local HttpService = game:GetService("HttpService")

local MAX_SEARCH_TERMS = 120
local MAX_RECORDS = 100
local MAX_PAGE_BYTES = 70000
local SCAN_CATEGORY = "__SCAN_CATEGORY__"
local SCAN_OFFSET = __SCAN_OFFSET__
local SCAN_LIMIT = __SCAN_LIMIT__
local KNOWN_ITEMS = HttpService:JSONDecode(__KNOWN_ITEMS__)
local categories = {SCAN_CATEGORY}
local items = {}
local hasMore = false
local encodedBytes = 80
local oversizedItems = {}

local function uniqueSorted(values, limit)
    local seen = {}
    local result = {}
    for _, value in values do
        if value ~= "" and not seen[value] then
            seen[value] = true
            table.insert(result, value)
            if limit and #result >= limit then break end
        end
    end
    table.sort(result)
    return result
end

local function collectRecords(source, pattern, method)
    local records = {}
    local cursor = 1
    while cursor <= #source do
        local first, last, name = string.find(source, pattern, cursor)
        if not first then break end
        local _, lineBreaks = string.gsub(string.sub(source, 1, first - 1), "\\n", "")
        table.insert(records, {Name = name, Method = method, Line = lineBreaks + 1})
        if #records >= MAX_RECORDS then break end
        cursor = math.max(last + 1, first + 1)
    end
    return records
end

local function appendRecords(target, source)
    for _, record in source do
        if #target >= MAX_RECORDS then break end
        table.insert(target, record)
    end
end

local function collectCallRecords(source)
    local records = {}
    local skipped = { ["function"] = true, ["if"] = true, ["for"] = true, ["while"] = true }
    local cursor = 1
    while cursor <= #source do
        local first, last, name = string.find(source, "([%a_][%w_]*)%s*%(", cursor)
        if not first then break end
        local previous = first > 1 and string.sub(source, first - 1, first - 1) or ""
        if previous ~= "." and previous ~= ":" and not skipped[name] then
            local _, lineBreaks = string.gsub(string.sub(source, 1, first - 1), "\\n", "")
            table.insert(records, {Name = name, Method = "Call", Line = lineBreaks + 1})
            if #records >= MAX_RECORDS then break end
        end
        cursor = math.max(last + 1, first + 1)
    end
    return records
end

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

local function stripComments(source)
    local output = table.create(#source)
    local index = 1
    local quote = nil
    local preserveString = false
    local function shouldPreserveLiteral(position)
        local prefix = string.sub(source, math.max(1, position - 100), position - 1)
        return string.match(prefix, "GetService%s*%(%s*$") ~= nil or
            string.match(prefix, "[GS]etAttribute%s*%(%s*$") ~= nil or
            string.match(prefix, "GetDataStore%s*%(%s*$") ~= nil or
            string.match(prefix, "GetOrderedDataStore%s*%(%s*$") ~= nil or
            string.match(prefix, "WaitForChild%s*%(%s*$") ~= nil or
            string.match(prefix, "FindFirstChild%s*%(%s*$") ~= nil or
            string.match(prefix, "require%s*%(%s*$") ~= nil
    end
    while index <= #source do
        local character = string.sub(source, index, index)
        local nextCharacter = string.sub(source, index + 1, index + 1)
        if quote then
            if character == "\\\\" then
                table.insert(output, preserveString and character or " ")
                if index < #source then
                    index += 1
                    local escaped = string.sub(source, index, index)
                    table.insert(output, preserveString and escaped or (escaped == "\\n" and "\\n" or " "))
                end
            elseif character == quote then
                table.insert(output, character)
                quote = nil
                preserveString = false
            else
                table.insert(output, preserveString and character or (character == "\\n" and "\\n" or " "))
            end
        elseif character == "\\"" or character == "'" then
            quote = character
            preserveString = shouldPreserveLiteral(index)
            table.insert(output, character)
        elseif character == "[" then
            local remainder = string.sub(source, index)
            local openerStart, relativeOpenerEnd, equals = string.find(remainder, "^%[(=*)%[")
            if openerStart then
                local openerEnd = index - 1 + relativeOpenerEnd
                local closePattern = "]" .. equals .. "]"
                local _, closeEnd = string.find(source, closePattern, openerEnd + 1, true)
                local stringEnd = closeEnd or #source
                for stringIndex = index, stringEnd do
                    local stringCharacter = string.sub(source, stringIndex, stringIndex)
                    table.insert(output, stringCharacter == "\\n" and "\\n" or " ")
                end
                index = stringEnd
            else
                table.insert(output, character)
            end
        elseif character == "-" and nextCharacter == "-" then
            local remainder = string.sub(source, index + 2)
            local openerStart, relativeOpenerEnd, equals = string.find(remainder, "^%[(=*)%[")
            if openerStart then
                local openerEnd = index + 1 + relativeOpenerEnd
                local closePattern = "]" .. equals .. "]"
                local closeStart, closeEnd = string.find(source, closePattern, openerEnd + 1, true)
                local commentEnd = closeEnd or #source
                for commentIndex = index, commentEnd do
                    local commentCharacter = string.sub(source, commentIndex, commentIndex)
                    table.insert(output, commentCharacter == "\\n" and "\\n" or " ")
                end
                index = commentEnd
            else
                while index <= #source and string.sub(source, index, index) ~= "\\n" do
                    table.insert(output, " ")
                    index += 1
                end
                if index <= #source then table.insert(output, "\\n") end
            end
        else
            table.insert(output, character)
        end
        index += 1
    end
    return table.concat(output)
end

local function inspectSource(container, preloadedSource)
    local ok = preloadedSource ~= nil
    local source = preloadedSource
    if not ok then
        ok, source = pcall(function()
            return container.Source
        end)
    end
    if not ok then
        return {
            Requires = {},
            ServicesUsed = {},
            SearchTerms = {},
            RemoteUsage = {},
            DataStoreUsage = {},
            Attributes = {},
            AttributeUsage = {},
            Functions = {},
            FunctionDefinitions = {},
            Calls = {},
            CallSites = {},
            SourceReadable = false,
        }
    end
    local originalSource = source
    source = stripComments(source)

    local requires = {}
    local servicesUsed = {}
    local searchTerms = {}
    local attributes = {}
    local attributeUsage = {}
    local functions = {}
    local functionDefinitions = {}
    local calls = {}
    local callSites = {}
    local remoteUsage = {}
    local dataStoreUsage = {}
    local remoteAliases = {}

    for target in string.gmatch(source, "require%s*%(%s*([^%)]+)") do
        local name = string.match(target, "[\\"']([^%\\"']+)[\\"']") or
            string.match(target, "([%a_][%w_]*)%s*$")
        if name then name = string.match(name, "^%s*(.-)%s*$") end
        if name and name ~= "require" and name ~= "script" then
            table.insert(requires, name)
        end
    end
    for service in string.gmatch(source, "GetService%s*%(%s*[\\"']([%w_]+)[\\"']%s*%)") do
        table.insert(servicesUsed, service)
    end
    for method, attribute in string.gmatch(source, "([GS]etAttribute)%s*%(%s*[\\"']([^%\\"']+)[\\"']") do
        table.insert(attributes, attribute)
        table.insert(attributeUsage, {Name = attribute, Method = method})
    end
    for functionName in string.gmatch(source, "function%s+([%w_%.:]+)%s*%(") do
        table.insert(functions, functionName)
    end
    appendRecords(functionDefinitions, collectRecords(source, "function%s+([%w_%.:]+)%s*%(", "Definition"))
    appendRecords(functionDefinitions, collectRecords(source, "([%w_%.:]+)%s*=%s*function%s*%(", "Definition"))
    for functionName in string.gmatch(source, "local%s+function%s+([%w_]+)%s*%(") do
        table.insert(functions, functionName)
    end
    local callSource = string.gsub(source, "function%s+[%w_%.:]+%s*%(", function(declaration)
        return string.rep(" ", #declaration)
    end)
    callSource = string.gsub(callSource, "[%w_%.:]+%s*=%s*function%s*%(", function(declaration)
        return string.rep(" ", #declaration)
    end)
    appendRecords(callSites, collectRecords(callSource, "[%w_%)%]]+[%.:]([%a_][%w_]*)%s*%(", "Call"))
    appendRecords(callSites, collectCallRecords(callSource))
    for _, callSite in callSites do
        table.insert(calls, callSite.Name)
    end
    for storeName in string.gmatch(source, "GetDataStore%s*%(%s*[\\"']([^%\\"']+)[\\"']") do
        table.insert(dataStoreUsage, {Name = storeName, Method = "GetDataStore"})
        if #dataStoreUsage >= MAX_RECORDS then break end
    end
    for symbol, remoteName in string.gmatch(source, "local%s+([%w_]+)%s*=%s*[^\\n]-WaitForChild%s*%(%s*[\\"']([^%\\"']+)[\\"']") do
        remoteAliases[symbol] = remoteName
    end
    for symbol, remoteName in string.gmatch(source, "local%s+([%w_]+)%s*=%s*[^\\n]-FindFirstChild%s*%(%s*[\\"']([^%\\"']+)[\\"']") do
        remoteAliases[symbol] = remoteName
    end

    local remoteMethods = {
        "FireServer", "InvokeServer", "FireClient", "FireAllClients",
        "InvokeClient", "OnServerEvent", "OnServerInvoke", "OnClientEvent", "OnClientInvoke"
    }
    for _, method in remoteMethods do
        local colonPattern = "([%w_]+)%s*:%s*" .. method .. "%s*%("
        local dotPattern = "([%w_]+)%s*%." .. method
        appendRecords(remoteUsage, collectRecords(source, colonPattern, method))
        appendRecords(remoteUsage, collectRecords(source, dotPattern, method))
    end
    for _, record in remoteUsage do
        record.Symbol = record.Name
        record.Name = remoteAliases[record.Name] or record.Name
    end

    local seenTerms = {}
    for identifier in string.gmatch(source, "([%a_][%w_]+)") do
        local lowered = string.lower(identifier)
        if #identifier >= 4 and not seenTerms[lowered] and #searchTerms < MAX_SEARCH_TERMS then
            seenTerms[lowered] = true
            table.insert(searchTerms, identifier)
        end
    end

    return {
        Requires = uniqueSorted(requires, 50),
        ServicesUsed = uniqueSorted(servicesUsed, 30),
        SearchTerms = uniqueSorted(searchTerms),
        RemoteUsage = remoteUsage,
        DataStoreUsage = dataStoreUsage,
        Attributes = uniqueSorted(attributes, 50),
        AttributeUsage = attributeUsage,
        Functions = uniqueSorted(functions, 80),
        FunctionDefinitions = functionDefinitions,
        Calls = uniqueSorted(calls, 120),
        CallSites = callSites,
        SourceHash = sourceFingerprint(originalSource),
        SourceLength = #originalSource,
        SourceLines = select(2, string.gsub(originalSource, "\\n", "")) + 1,
        EvidenceQuality = "lexically-masked-regex",
        LifecycleOwner = string.find(source, "Janitor", 1, true) and "Janitor" or
            (string.find(source, "Trove", 1, true) and "Trove" or
            (string.find(source, "Maid", 1, true) and "Maid" or "")),
        HasTrackedCancellation = string.find(source, "task.cancel", 1, true) ~= nil,
        UsesNetworkOwnership = string.find(source, "SetNetworkOwner", 1, true) ~= nil,
        WritesAnchored = string.find(source, "%.Anchored%s*=") ~= nil,
        UsesHotSignal = string.find(source, "RenderStepped", 1, true) ~= nil or
            string.find(source, "Heartbeat", 1, true) ~= nil or
            string.find(source, "Stepped", 1, true) ~= nil,
        SourceReadable = true,
    }
end

for _, category in categories do
    local service = game:GetService(category)
    local eligibleIndex = 0
    local stack = {}
    local rootChildren = service:GetChildren()
    for index = #rootChildren, 1, -1 do
        table.insert(stack, rootChildren[index])
    end
    while #stack > 0 do
        local descendant = table.remove(stack)
        if descendant:IsA("LuaSourceContainer") or descendant:IsA("RemoteEvent") or descendant:IsA("RemoteFunction") then
            eligibleIndex += 1
            if eligibleIndex > SCAN_OFFSET + SCAN_LIMIT then
                hasMore = true
                break
            end
            if eligibleIndex > SCAN_OFFSET and eligibleIndex <= SCAN_OFFSET + SCAN_LIMIT then
                local item = {
                    Name = descendant.Name,
                    Class = descendant.ClassName,
                    Parent = descendant.Parent and descendant.Parent.Name or "",
                    Path = descendant:GetFullName(),
                    Category = category,
                }
                local known = KNOWN_ITEMS[eligibleIndex - SCAN_OFFSET]
                if descendant:IsA("LuaSourceContainer") then
                    local sourceOk, source = pcall(function()
                        return descendant.Source
                    end)
                    if sourceOk and known and known.Path == item.Path and known.Class == item.Class and
                        known.SourceHash ~= "" and known.SourceHash == sourceFingerprint(source) then
                        item.Unchanged = true
                        item.SourceReadable = true
                        item.SourceHash = known.SourceHash
                        item.SourceLength = #source
                        item.SourceLines = select(2, string.gsub(source, "\\n", "")) + 1
                    else
                        local metadata = inspectSource(descendant, sourceOk and source or nil)
                        for key, value in metadata do
                            item[key] = value
                        end
                    end
                elseif known and known.Path == item.Path and known.Class == item.Class then
                    item.Unchanged = true
                end
                local encodedItem = HttpService:JSONEncode(item)
                local itemBytes = #encodedItem + 1
                if encodedBytes + itemBytes > MAX_PAGE_BYTES then
                    if #items > 0 then
                        hasMore = true
                        break
                    end
                    table.insert(oversizedItems, item.Path)
                    encodedBytes += #HttpService:JSONEncode(item.Path) + 1
                    item = {
                        Name = item.Name,
                        Class = item.Class,
                        Parent = item.Parent,
                        Path = item.Path,
                        Category = item.Category,
                        SourceReadable = item.SourceReadable,
                        SourceHash = item.SourceHash,
                        SourceLength = item.SourceLength,
                        SourceLines = item.SourceLines,
                        MetadataIncomplete = true,
                    }
                    encodedItem = HttpService:JSONEncode(item)
                    itemBytes = #encodedItem + 1
                end
                table.insert(items, item)
                encodedBytes += itemBytes
            end
        end
        local children = descendant:GetChildren()
        for index = #children, 1, -1 do
            table.insert(stack, children[index])
        end
    end
end

local nextOffset = hasMore and SCAN_OFFSET + #items or nil

return HttpService:JSONEncode({
    Items = items,
    NextOffset = nextOffset,
    HasMore = hasMore,
    EncodedBytes = encodedBytes,
    OversizedItems = oversizedItems,
})
`;

const SCAN_CATEGORIES = [
    'ServerScriptService',
    'ReplicatedStorage',
    'StarterPlayer',
    'StarterGui',
    'ServerStorage',
    'Workspace',
    'StarterPack'
];
const SCAN_PAGE_SIZE = 150;
const MAX_SCAN_PAGES_PER_CATEGORY = 40;

export async function run(_args = {}, studioCommunicator) {
    let scanError = null;
    let liveIdentity = null;
    const scanStartedAt = Date.now();
    const cachedBefore = _args.incremental === true ? loadBrain() : null;

    if (studioCommunicator?.isAlive()) {
        try {
            const placeIdentity = await executeLuau(studioCommunicator, `
local HttpService = game:GetService("HttpService")
return HttpService:JSONEncode({
    Name = game.Name,
    PlaceId = game.PlaceId,
    GameId = game.GameId,
    CreatorId = game.CreatorId,
})
`, { label: 'Project identity read' });
            liveIdentity = placeIdentity;
            const reusableBrain = cachedBefore?.ok && !cachedBefore.staleSchema &&
                placeIdentitiesMatch(cachedBefore.brain.PlaceIdentity, placeIdentity)
                ? cachedBefore.brain
                : null;
            const reusableByPath = new Map((reusableBrain?.AllItems || []).map(item => [item.Path, item]));
            const items = [];
            let reusedItems = 0;
            const incompleteCategories = [];
            const oversizedItems = [];
            for (const category of SCAN_CATEGORIES) {
                const knownCategory = (reusableBrain?.AllItems || []).filter(item => item.Category === category);
                let offset = 0;
                for (let page = 0; page < MAX_SCAN_PAGES_PER_CATEGORY; page += 1) {
                    const knownPage = knownCategory.slice(offset, offset + SCAN_PAGE_SIZE).map(item => ({
                        Path: item.Path,
                        Class: item.Class,
                        SourceHash: item.SourceHash || ''
                    }));
                    const result = await studioCommunicator.callTool('execute_luau', {
                        code: buildScannerScript(category, offset, knownPage),
                        datamodel_type: 'Edit'
                    });
                    const chunk = parseStudioChunk(result);
                    for (const item of chunk.Items) {
                        const cachedItem = item.Unchanged === true ? reusableByPath.get(item.Path) : null;
                        if (cachedItem) {
                            items.push(cachedItem);
                            reusedItems += 1;
                        } else {
                            const { Unchanged: _unchanged, ...scannedItem } = item;
                            items.push(scannedItem);
                        }
                    }
                    oversizedItems.push(...chunk.OversizedItems);
                    if (chunk.NextOffset === null) break;
                    offset = chunk.NextOffset;
                    if (page === MAX_SCAN_PAGES_PER_CATEGORY - 1) {
                        incompleteCategories.push({
                            Category: category,
                            ScannedEligibleItems: offset,
                            PageLimit: MAX_SCAN_PAGES_PER_CATEGORY,
                            PageSize: SCAN_PAGE_SIZE
                        });
                        break;
                    }
                }
            }
            const endingIdentity = await executeLuau(studioCommunicator, `
local HttpService = game:GetService("HttpService")
return HttpService:JSONEncode({
    Name = game.Name,
    PlaceId = game.PlaceId,
    GameId = game.GameId,
    CreatorId = game.CreatorId,
})
`, { label: 'Project identity revalidation' });
            if (!placeIdentitiesMatch(endingIdentity, placeIdentity)) {
                throw new Error('The active Studio place changed during the paginated scan.');
            }
            if (oversizedItems.length > 0) {
                incompleteCategories.push({
                    Category: 'EncodedMetadata',
                    OversizedItems: oversizedItems.slice(0, 100),
                    OversizedItemCount: oversizedItems.length,
                    ByteLimit: 70_000
                });
            }
            if (incompleteCategories.length > 0) {
                const cached = loadBrain();
                return JSON.stringify({
                    Status: 'Live Scan Incomplete',
                    PlaceIdentity: placeIdentity,
                    IncompleteCategories: incompleteCategories,
                    PartialItemCount: items.length,
                    CachePreserved: true,
                    Cache: cached.ok ? cacheMetadata(cached.brain, cached.staleSchema) : { Error: cached.error },
                    SuggestedAction: 'Narrow the project or raise the explicit scan budget before replacing the cache.'
                }, null, 2);
            }
            const brain = buildBrain(items, placeIdentity);
            saveBrain(brain);
            const refresh = _args.incremental === true
                ? reusableBrain
                    ? summarizeRefresh(reusableBrain.AllItems, items, reusedItems, Date.now() - scanStartedAt)
                    : {
                        Mode: 'full-rebuild',
                        Reason: cachedBefore?.ok ? 'The cached schema or place identity could not be reused.' : cachedBefore?.error,
                        DurationMs: Date.now() - scanStartedAt
                    }
                : null;
            return JSON.stringify(formatBrainSummary(brain, true, false, refresh), null, 2);
        } catch (error) {
            scanError = error instanceof Error ? error.message : String(error);
        }
    } else {
        scanError = 'Roblox Studio MCP is unavailable.';
    }

    const cached = loadBrain();
    if (cached.ok) {
        const cachedIdentity = cached.brain.PlaceIdentity;
        const placeMismatch = liveIdentity && !placeIdentitiesMatch(cachedIdentity, liveIdentity);
        if (placeMismatch) {
            return JSON.stringify({
                Status: 'Cached Brain Rejected',
                Error: scanError,
                PlaceMismatch: true,
                LivePlaceIdentity: liveIdentity,
                CachedPlaceIdentity: cachedIdentity || null,
                SuggestedAction: 'Keep the intended place active and rerun analyze_project.'
            }, null, 2);
        }
        return JSON.stringify({
            ...formatBrainSummary(cached.brain, false, cached.staleSchema),
            LiveScanError: scanError
        }, null, 2);
    }

    return JSON.stringify({
        Status: 'Scan Failed',
        Error: scanError,
        CacheError: cached.error,
        SuggestedAction: 'Open Roblox Studio with its MCP connection active, then run analyze_project again.'
    }, null, 2);
}

export async function refresh(args = {}, studioCommunicator) {
    return run({ ...args, incremental: true }, studioCommunicator);
}

export function parseStudioItems(response) {
    return parseStudioChunk(response).Items;
}

export function parseStudioChunk(response) {
    const parsed = parseStudioPayload(response, 'Studio scan');
    if (Array.isArray(parsed)) {
        return { Items: parsed, NextOffset: null };
    }
    if (!parsed || !Array.isArray(parsed.Items)) {
        throw new Error('Studio scan returned an unexpected response instead of a scan page.');
    }
    const nextOffset = parsed.NextOffset === null || parsed.NextOffset === undefined
        ? null
        : Number(parsed.NextOffset);
    if (nextOffset !== null && (!Number.isSafeInteger(nextOffset) || nextOffset < 0)) {
        throw new Error('Studio scan returned an invalid pagination cursor.');
    }
    return {
        Items: parsed.Items,
        NextOffset: nextOffset,
        HasMore: parsed.HasMore === true || nextOffset !== null,
        EncodedBytes: Number(parsed.EncodedBytes || 0),
        OversizedItems: Array.isArray(parsed.OversizedItems) ? parsed.OversizedItems.map(String) : []
    };
}

export function buildScannerScript(category, offset, knownItems = []) {
    if (!SCAN_CATEGORIES.includes(category)) throw new Error(`Unsupported scan category '${category}'.`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Scan offset must be a non-negative integer.');
    return LUAU_SCANNER_SCRIPT
        .replace('"__SCAN_CATEGORY__"', JSON.stringify(category))
        .replace('__SCAN_OFFSET__', String(offset))
        .replace('__SCAN_LIMIT__', String(SCAN_PAGE_SIZE))
        .replace('__KNOWN_ITEMS__', luaJson(Array.isArray(knownItems) ? knownItems : []));
}

function buildBrain(items, placeIdentity) {
    const brain = {
        SchemaVersion: BRAIN_SCHEMA_VERSION,
        ScannedAt: new Date().toISOString(),
        PlaceIdentity: placeIdentity,
        AllItems: items
    };
    for (const category of ['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'StarterGui', 'ServerStorage', 'Workspace', 'StarterPack']) {
        brain[category] = items.filter(item => item.Category === category);
    }
    return brain;
}

function formatBrainSummary(brain, isLive, staleSchema = false, refresh = null) {
    const readableScripts = brain.AllItems.filter(item => item.SourceReadable === true).length;
    return {
        Status: refresh?.Mode === 'incremental'
            ? 'Incremental Refresh Complete'
            : refresh ? 'Refresh Full Rebuild Complete' : isLive ? 'Live Scan Complete' : 'Cached Brain Loaded',
        ...cacheMetadata(brain, staleSchema),
        TotalScannedInstances: brain.AllItems.length,
        SourceReadableScripts: readableScripts,
        ScannedScopes: ['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'StarterGui', 'ServerStorage', 'Workspace', 'StarterPack'],
        PlaceIdentity: brain.PlaceIdentity || null,
        Refresh: refresh,
        SystemsOverview: {
            ServerScripts: (brain.ServerScriptService || []).length,
            SharedModules: (brain.ReplicatedStorage || []).length,
            ClientScripts: (brain.StarterPlayer || []).length,
            UIElements: (brain.StarterGui || []).length,
            Remotes: brain.AllItems.filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class)).length
        }
    };
}

function summarizeRefresh(before, after, reusedItems, durationMs) {
    const oldByPath = new Map(before.map(item => [item.Path, item]));
    const newByPath = new Map(after.map(item => [item.Path, item]));
    let added = after.filter(item => !oldByPath.has(item.Path));
    let deleted = before.filter(item => !newByPath.has(item.Path));
    const moved = [];
    for (const oldItem of [...deleted]) {
        if (!oldItem.SourceHash) continue;
        const matches = added.filter(item => item.Class === oldItem.Class && item.SourceHash === oldItem.SourceHash);
        if (matches.length !== 1) continue;
        const newItem = matches[0];
        moved.push({ From: oldItem.Path, To: newItem.Path });
        deleted = deleted.filter(item => item !== oldItem);
        added = added.filter(item => item !== newItem);
    }
    const changed = after.filter(item => {
        const old = oldByPath.get(item.Path);
        return old && `${old.Class}:${old.SourceHash || ''}` !== `${item.Class}:${item.SourceHash || ''}`;
    });
    return {
        Mode: 'incremental',
        DurationMs: durationMs,
        ReusedItems: reusedItems,
        ReindexedItems: after.length - reusedItems,
        Added: added.length,
        Deleted: deleted.length,
        Moved: moved.length,
        Changed: changed.length,
        RemotesAdded: added.filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class)).length,
        RemotesDeleted: deleted.filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class)).length,
        AddedPaths: added.slice(0, 50).map(item => item.Path),
        DeletedPaths: deleted.slice(0, 50).map(item => item.Path),
        MovedPaths: moved.slice(0, 50),
        ChangedPaths: changed.slice(0, 50).map(item => item.Path)
    };
}
