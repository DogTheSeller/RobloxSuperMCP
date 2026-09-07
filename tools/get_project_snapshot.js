import {
    loadBrain,
    cacheMetadata,
    placeIdentitiesMatch
} from './brain_store.js';
import * as analyzeProject from './analyze_project.js';
import {
    clampInteger,
    executeLuau,
    luaJson,
    paginate,
    summarizeItem
} from './studio_utils.js';

const TREE_ROOTS = [
    'ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'StarterGui',
    'ServerStorage', 'Workspace', 'StarterPack'
];

export async function run(args = {}, studioCommunicator) {
    let refreshResult = null;
    if (args.refresh === true) {
        refreshResult = JSON.parse(await analyzeProject.refresh({}, studioCommunicator));
    }

    const loaded = loadBrain();
    if (!loaded.ok) return JSON.stringify({ error: loaded.error, RefreshResult: refreshResult }, null, 2);

    const brain = loaded.brain;
    const classCounts = {};
    const categoryCounts = {};
    for (const item of brain.AllItems) {
        classCounts[item.Class] = (classCounts[item.Class] || 0) + 1;
        categoryCounts[item.Category] = (categoryCounts[item.Category] || 0) + 1;
    }

    let livePlace = null;
    let liveTree = null;
    if (studioCommunicator?.isAlive?.()) {
        try {
            livePlace = await executeLuau(studioCommunicator, `
local HttpService = game:GetService("HttpService")
return HttpService:JSONEncode({
    Name = game.Name,
    PlaceId = game.PlaceId,
    GameId = game.GameId,
    JobId = game.JobId,
    CreatorId = game.CreatorId,
    PrivateServerId = game.PrivateServerId,
})
`, { label: 'Place identity inspection' });
        } catch (error) {
            livePlace = { Error: error instanceof Error ? error.message : String(error) };
        }
    }
    const cachedIdentity = brain.PlaceIdentity;
    const placeMismatch = livePlace && !livePlace.Error &&
        !placeIdentitiesMatch(cachedIdentity, livePlace);
    if (placeMismatch) {
        return JSON.stringify({
            Status: 'Cached Snapshot Rejected',
            PlaceMismatch: true,
            LivePlace: args.include_live_place === false ? null : livePlace,
            CachedPlaceIdentity: cachedIdentity || null,
            Cache: cacheMetadata(brain, loaded.staleSchema),
            RefreshResult: refreshResult,
            SuggestedAction: 'Run analyze_project while this place remains active.'
        }, null, 2);
    }
    if (studioCommunicator?.isAlive?.() && args.include_live_tree !== false) {
        const roots = Array.isArray(args.tree_roots)
            ? args.tree_roots.map(String).filter(root => TREE_ROOTS.includes(root))
            : TREE_ROOTS;
        const treeRequest = {
            roots,
            offset: clampInteger(args.offset, 0, 0, 100_000),
            limit: clampInteger(args.limit, 50, 1, 200)
        };
        try {
            liveTree = await executeLuau(studioCommunicator, `
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local request = HttpService:JSONDecode(${luaJson(treeRequest)})

local function serialize(value)
    local kind = typeof(value)
    if kind == "string" or kind == "number" or kind == "boolean" then return value end
    return tostring(value)
end

local items = {}
local total = 0
for _, rootName in request.roots do
    local root = game:GetService(rootName)
    for _, instance in root:GetDescendants() do
        total += 1
        if total <= request.offset or #items >= request.limit then continue end
        local attributes = {}
        local attributeCount = 0
        for name, value in instance:GetAttributes() do
            attributeCount += 1
            if attributeCount <= 30 then attributes[name] = serialize(value) end
        end
        local properties = {}
        if instance:IsA("ValueBase") then properties.Value = serialize(instance.Value) end
        if instance:IsA("BasePart") then
            properties.Anchored = instance.Anchored
            properties.CanCollide = instance.CanCollide
            properties.CollisionGroup = instance.CollisionGroup
        end
        local enabledOk, enabled = pcall(function() return instance.Enabled end)
        if enabledOk then properties.Enabled = enabled end
        table.insert(items, {
            Name = instance.Name,
            ClassName = instance.ClassName,
            Path = instance:GetFullName(),
            Parent = instance.Parent and instance.Parent:GetFullName() or nil,
            ChildCount = #instance:GetChildren(),
            Attributes = attributes,
            AttributeCount = attributeCount,
            Tags = CollectionService:GetTags(instance),
            Properties = properties,
        })
    end
end
return HttpService:JSONEncode({
    Items = items,
    Offset = request.offset,
    Limit = request.limit,
    Returned = #items,
    Total = total,
    NextOffset = request.offset + #items < total and request.offset + #items or nil,
})
`, { label: 'Live game-tree snapshot', timeoutMs: 30_000 });
        } catch (error) {
            liveTree = { Error: error instanceof Error ? error.message : String(error) };
        }
    }

    const filter = String(args.query || '').trim().toLowerCase();
    const filtered = filter
        ? brain.AllItems.filter(item => `${item.Name} ${item.Path} ${item.Class}`.toLowerCase().includes(filter))
        : brain.AllItems;
    const page = paginate(filtered.map(summarizeItem), args, { defaultLimit: 50, maxLimit: 200 });

    return JSON.stringify({
        Status: 'Snapshot Ready',
        SnapshotId: `${brain.ScannedAt || 'unknown'}:${brain.AllItems.length}`,
        LivePlace: args.include_live_place === false ? null : livePlace,
        PlaceMismatch: false,
        LiveTree: liveTree,
        Cache: cacheMetadata(brain, loaded.staleSchema),
        RefreshResult: refreshResult,
        Counts: {
            TotalIndexedInstances: brain.AllItems.length,
            ByClass: classCounts,
            ByCategory: categoryCounts,
            Scripts: brain.AllItems.filter(item => item.Class.endsWith('Script')).length,
            Remotes: brain.AllItems.filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class)).length,
            AttributesObserved: new Set(brain.AllItems.flatMap(item => item.Attributes)).size
        },
        RemoteEndpoints: brain.AllItems
            .filter(item => ['RemoteEvent', 'RemoteFunction'].includes(item.Class))
            .slice(0, 300)
            .map(summarizeItem),
        PackagesAndModules: brain.AllItems
            .filter(item => item.Class === 'ModuleScript')
            .slice(0, 200)
            .map(summarizeItem),
        CollectionBounds: {
            RemoteEndpointsLimit: 300,
            PackagesAndModulesLimit: 200
        },
        Results: page.Items,
        Page: page.Page,
        Evidence: liveTree && !liveTree.Error
            ? 'live-game-tree + indexed-project'
            : livePlace && !livePlace.Error ? 'live-place + indexed-project' : 'indexed-project'
    }, null, 2);
}
