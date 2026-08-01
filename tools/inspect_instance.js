import {
    LUAU_PATH_RESOLVER,
    LUAU_SOURCE_FINGERPRINT,
    clampInteger,
    executeLuau,
    luaJson
} from './studio_utils.js';

export async function run(args = {}, studioCommunicator) {
    const rawPaths = Array.isArray(args.paths) ? args.paths : [args.path];
    const paths = [...new Set(rawPaths.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 20);
    if (paths.length === 0) return JSON.stringify({ error: 'Provide path or paths with exact Studio instance paths.' });

    const maxChildren = clampInteger(args.max_children, 100, 1, 500);
    const sourceLimit = clampInteger(args.source_limit, 20_000, 0, 100_000);
    const includeSource = args.include_source === true;
    const properties = [...new Set([
        'Name', 'ClassName', 'Archivable', 'Enabled', 'Value', 'CFrame', 'Position', 'Size',
        'Transparency', 'CanCollide', 'Anchored', 'Massless', 'CollisionGroup', 'PrimaryPart',
        ...(Array.isArray(args.properties) ? args.properties.map(String) : [])
    ])].slice(0, 50);

    const code = `
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
${LUAU_PATH_RESOLVER}
${LUAU_SOURCE_FINGERPRINT}
local request = HttpService:JSONDecode(${luaJson({ paths, properties, maxChildren, includeSource, sourceLimit })})

local function serialize(value)
    local kind = typeof(value)
    if value == nil then return nil end
    if kind == "string" or kind == "boolean" or kind == "number" then return value end
    if kind == "Instance" then return value:GetFullName() end
    if kind == "Vector2" or kind == "Vector3" or kind == "CFrame" or kind == "Color3" or
        kind == "UDim" or kind == "UDim2" or kind == "BrickColor" or kind == "EnumItem" then
        return tostring(value)
    end
    return "<" .. kind .. ">"
end

local output = {}
for _, path in request.paths do
    local instance = resolvePath(path)
    if not instance then
        table.insert(output, {Path = path, Found = false})
        continue
    end

    local attributes = {}
    for name, value in instance:GetAttributes() do
        attributes[name] = serialize(value)
    end
    local properties = {}
    for _, property in request.properties do
        local ok, value = pcall(function()
            return instance[property]
        end)
        if ok then
            properties[property] = serialize(value)
        end
    end
    local children = {}
    for index, child in instance:GetChildren() do
        if index > request.maxChildren then break end
        table.insert(children, {
            Name = child.Name,
            ClassName = child.ClassName,
            Path = child:GetFullName(),
        })
    end
    local record = {
        Path = path,
        Found = true,
        FullName = instance:GetFullName(),
        Name = instance.Name,
        ClassName = instance.ClassName,
        Parent = instance.Parent and instance.Parent:GetFullName() or nil,
        Attributes = attributes,
        Tags = CollectionService:GetTags(instance),
        Children = children,
        ChildCount = #instance:GetChildren(),
        Properties = properties,
    }
    if request.includeSource and instance:IsA("LuaSourceContainer") then
        local ok, source = pcall(function()
            return instance.Source
        end)
        if ok then
            record.Source = string.sub(source, 1, request.sourceLimit)
            record.SourceTruncated = #source > request.sourceLimit
            record.SourceLength = #source
            record.SourceHash = sourceFingerprint(source)
        end
    end
    table.insert(output, record)
end
return HttpService:JSONEncode(output)
`;
    const instances = await executeLuau(studioCommunicator, code, { label: 'Instance inspection' });
    return JSON.stringify({
        Instances: Array.isArray(instances) ? instances : [],
        Requested: paths.length,
        Evidence: 'live-studio',
        Caveat: 'Properties are read through a bounded allow-list; request additional property names explicitly.'
    }, null, 2);
}
