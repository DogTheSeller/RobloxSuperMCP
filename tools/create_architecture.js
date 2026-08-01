import {
    LUAU_PATH_RESOLVER,
    LUAU_SOURCE_FINGERPRINT,
    contentHash,
    executeLuau,
    luaJson
} from './studio_utils.js';
import {
    finalizeTransaction,
    findTransactionByIdempotencyKey,
    prepareTransaction,
    publicTransaction
} from './transaction_store.js';

const FORBIDDEN_PROPERTIES = new Set(['Parent', 'ClassName', 'Name', 'Source']);

function normalizeManifest(args) {
    const raw = Array.isArray(args.nodes) ? args.nodes : args.manifest?.nodes;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 150) {
        throw new Error('Provide manifest.nodes with between 1 and 150 node definitions.');
    }
    const nodes = raw.map((node, index) => {
        const path = String(node.path || '').trim();
        const className = String(node.class_name || node.className || '').trim();
        if (!path || !path.includes('.')) throw new Error(`Node ${index + 1} needs a full service-relative path.`);
        if (!className) throw new Error(`Node '${path}' needs class_name.`);
        const propertyEntries = Object.entries(node.properties || {});
        const attributeEntries = Object.entries(node.attributes || {});
        const forbidden = propertyEntries.find(([name]) => FORBIDDEN_PROPERTIES.has(name));
        if (forbidden) throw new Error(`Node '${path}' cannot set reserved property '${forbidden[0]}'.`);
        if (propertyEntries.length > 50) throw new Error(`Node '${path}' exceeds the 50-property limit.`);
        if (attributeEntries.length > 50) throw new Error(`Node '${path}' exceeds the 50-attribute limit.`);
        if (Array.isArray(node.tags) && node.tags.length > 25) {
            throw new Error(`Node '${path}' exceeds the 25-tag limit.`);
        }
        if (Object.hasOwn(node.attributes || {}, '_SuperMCPTransactionId')) {
            throw new Error(`Node '${path}' uses the reserved _SuperMCPTransactionId attribute.`);
        }
        const properties = Object.fromEntries(propertyEntries);
        return {
            path,
            className,
            properties,
            attributes: Object.fromEntries(attributeEntries),
            tags: Array.isArray(node.tags) ? [...new Set(node.tags.map(String).filter(Boolean))] : [],
            source: node.source === undefined ? null : String(node.source)
        };
    });
    nodes.sort((left, right) => left.path.split('.').length - right.path.split('.').length);
    const paths = nodes.map(node => node.path);
    if (new Set(paths).size !== paths.length) {
        throw new Error('Each architecture path may appear only once.');
    }
    return nodes;
}

export async function run(args = {}, studioCommunicator) {
    let nodes;
    try {
        nodes = normalizeManifest(args);
    } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
    }

    const idempotencyKey = args.idempotency_key ? String(args.idempotency_key) : null;
    const requestHash = contentHash(JSON.stringify(nodes));
    const manifestBytes = Buffer.byteLength(JSON.stringify(nodes), 'utf8');
    if (manifestBytes > 2_000_000) {
        return JSON.stringify({ error: 'Architecture manifest exceeds the 2,000,000-byte payload limit.' }, null, 2);
    }
    if (idempotencyKey && idempotencyKey.length > 200) {
        return JSON.stringify({ error: 'idempotency_key must be 200 characters or fewer.' }, null, 2);
    }
    if (args.dry_run !== true && !idempotencyKey) {
        return JSON.stringify({
            error: 'idempotency_key is required for a live architecture mutation.'
        }, null, 2);
    }
    if (!args.dry_run && idempotencyKey) {
        const existing = findTransactionByIdempotencyKey(idempotencyKey, 'create_architecture');
        if (existing) {
            if (existing.Metadata?.RequestHash !== requestHash) {
                return JSON.stringify({
                    Status: 'Idempotency Conflict',
                    error: 'This idempotency_key is already bound to a different architecture payload.',
                    Transaction: publicTransaction(existing)
                }, null, 2);
            }
            return JSON.stringify({
                Status: 'Existing Transaction',
                Transaction: publicTransaction(existing),
                IdempotentReplay: true
            }, null, 2);
        }
    }

    let code = `
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
${LUAU_PATH_RESOLVER}
${LUAU_SOURCE_FINGERPRINT}
local request = HttpService:JSONDecode(${luaJson({
        nodes,
        createMissingFolders: args.create_missing_folders !== false,
        dryRun: args.dry_run === true,
        maxJournalBytes: 4_000_000
    })})
local transactionId = "__SUPER_MCP_TRANSACTION_ID__"

local function encodeValue(value)
    local kind = typeof(value)
    if value == nil then return {Type = "Nil"} end
    if kind == "string" or kind == "number" or kind == "boolean" then
        return {Type = kind, Value = value}
    end
    if kind == "Vector2" then return {Type = kind, Value = {value.X, value.Y}} end
    if kind == "Vector3" then return {Type = kind, Value = {value.X, value.Y, value.Z}} end
    if kind == "Color3" then return {Type = kind, Value = {value.R, value.G, value.B}} end
    if kind == "CFrame" then return {Type = kind, Value = {value:GetComponents()}} end
    if kind == "UDim" then return {Type = kind, Value = {value.Scale, value.Offset}} end
    if kind == "UDim2" then
        return {Type = kind, Value = {value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset}}
    end
    if kind == "EnumItem" then return {Type = kind, Value = tostring(value)} end
    if kind == "Instance" then return {Type = kind, Value = value:GetFullName()} end
    return {Type = "Unsupported", Value = tostring(value)}
end

local function decodeValue(descriptor)
    if typeof(descriptor) ~= "table" or descriptor.Type == nil then
        return descriptor
    end
    local kind = descriptor.Type
    local value = descriptor.Value
    if kind == "Nil" then return nil end
    if kind == "Vector2" then return Vector2.new(value[1], value[2]) end
    if kind == "Vector3" then return Vector3.new(value[1], value[2], value[3]) end
    if kind == "Color3" then return Color3.new(value[1], value[2], value[3]) end
    if kind == "CFrame" then return CFrame.new(table.unpack(value)) end
    if kind == "UDim" then return UDim.new(value[1], value[2]) end
    if kind == "UDim2" then return UDim2.new(value[1], value[2], value[3], value[4]) end
    if kind == "EnumItem" then
        local parts = string.split(value, ".")
        if #parts == 3 and parts[1] == "Enum" then
            return Enum[parts[2]][parts[3]]
        end
        error("Invalid EnumItem descriptor: " .. tostring(value))
    end
    if kind == "Instance" then return resolvePath(value) end
    return value
end

local function descriptorsEqual(left, right)
    return HttpService:JSONEncode(left) == HttpService:JSONEncode(right)
end

if request.dryRun then
    local preview = {}
    local previewPaths = {}
    local journalBytes = 0
    local syntaxValidation = typeof(loadstring) == "function" and "available" or "unavailable"
    local function addPreview(change)
        local key = change.Kind .. ":" .. change.Path .. ":" .. tostring(change.Name or "")
        if not previewPaths[key] then
            previewPaths[key] = true
            table.insert(preview, change)
        end
    end
    for _, node in request.nodes do
        local instance = resolvePath(node.path)
        if not instance then
            local createOk, temporary = pcall(Instance.new, node.className)
            if not createOk then
                return HttpService:JSONEncode({
                    Status = "Rejected",
                    Error = "Cannot create " .. node.className .. ": " .. tostring(temporary),
                })
            end
            local validateOk, validateError = pcall(function()
                for property, descriptor in node.properties do
                    temporary[property] = decodeValue(descriptor)
                end
                for attribute, descriptor in node.attributes do
                    temporary:SetAttribute(attribute, decodeValue(descriptor))
                end
                if node.source ~= nil then
                    if not temporary:IsA("LuaSourceContainer") then
                        error("Source supplied for non-script: " .. node.path)
                    end
                    temporary.Source = node.source
                end
            end)
            temporary:Destroy()
            if not validateOk then
                return HttpService:JSONEncode({
                    Status = "Rejected",
                    Error = "Invalid configuration for " .. node.path .. ": " .. tostring(validateError),
                })
            end
            if node.source ~= nil and syntaxValidation == "available" then
                local compiled, compileError = loadstring(node.source, "=" .. node.path)
                if not compiled then
                    return HttpService:JSONEncode({
                        Status = "Rejected",
                        Error = "Luau syntax validation failed: " .. node.path,
                        SyntaxError = tostring(compileError),
                    })
                end
            end
            local segments = string.split(node.path, ".")
            local ok, current = pcall(function() return game:GetService(segments[1]) end)
            if not ok or not current then
                return HttpService:JSONEncode({Status = "Rejected", Error = "Unknown root service: " .. segments[1]})
            end
            local currentPath = segments[1]
            for index = 2, #segments - 1 do
                local parentPath = currentPath
                currentPath ..= "." .. segments[index]
                local child = current and current:FindFirstChild(segments[index]) or nil
                if not child then
                    if not request.createMissingFolders then
                        return HttpService:JSONEncode({
                            Status = "Rejected",
                            Error = "Missing parent: " .. currentPath,
                        })
                    end
                    addPreview({
                        Kind = "WouldCreate",
                        Path = currentPath,
                        ParentPath = parentPath,
                        Name = segments[index],
                        ClassName = "Folder",
                    })
                end
                current = child
            end
            local desiredProperties = {}
            for property, descriptor in node.properties do
                desiredProperties[property] = encodeValue(decodeValue(descriptor))
            end
            local desiredAttributes = {}
            for attribute, descriptor in node.attributes do
                desiredAttributes[attribute] = encodeValue(decodeValue(descriptor))
            end
            addPreview({
                Kind = "WouldCreate",
                Path = node.path,
                ParentPath = table.concat(segments, ".", 1, #segments - 1),
                Name = segments[#segments],
                ClassName = node.className,
                Properties = desiredProperties,
                Attributes = desiredAttributes,
                Tags = node.tags,
                SourceHash = node.source ~= nil and sourceFingerprint(node.source) or nil,
            })
            continue
        end
        if instance.ClassName ~= node.className then
            return HttpService:JSONEncode({
                Status = "Rejected",
                Error = "Class mismatch at " .. node.path .. ": expected " .. node.className .. ", found " .. instance.ClassName,
            })
        end
        for property, descriptor in node.properties do
            local readOk, before = pcall(function() return instance[property] end)
            if not readOk then
                return HttpService:JSONEncode({
                    Status = "Rejected",
                    Error = "Property is unreadable at " .. node.path .. ": " .. property,
                })
            end
            local decodeOk, after = pcall(decodeValue, descriptor)
            if not decodeOk then
                return HttpService:JSONEncode({Status = "Rejected", Error = tostring(after)})
            end
            if before ~= after then
                addPreview({
                    Kind = "WouldUpdateProperty",
                    Path = node.path,
                    Name = property,
                    Before = encodeValue(before),
                    After = encodeValue(after),
                })
            end
        end
        for attribute, descriptor in node.attributes do
            local before = instance:GetAttribute(attribute)
            local after = decodeValue(descriptor)
            if before ~= after then
                addPreview({
                    Kind = "WouldUpdateAttribute",
                    Path = node.path,
                    Name = attribute,
                    Before = encodeValue(before),
                    After = encodeValue(after),
                })
            end
        end
        for _, tag in node.tags do
            if not CollectionService:HasTag(instance, tag) then
                addPreview({Kind = "WouldAddTag", Path = node.path, Name = tag})
            end
        end
        if node.source ~= nil then
            if not instance:IsA("LuaSourceContainer") then
                return HttpService:JSONEncode({Status = "Rejected", Error = "Source supplied for non-script: " .. node.path})
            end
            if syntaxValidation == "available" then
                local compiled, compileError = loadstring(node.source, "=" .. node.path)
                if not compiled then
                    return HttpService:JSONEncode({
                        Status = "Rejected",
                        Error = "Luau syntax validation failed: " .. node.path,
                        SyntaxError = tostring(compileError),
                    })
                end
            end
            if instance.Source ~= node.source then
                journalBytes += #instance.Source + #node.source
                if journalBytes > request.maxJournalBytes then
                    return HttpService:JSONEncode({
                        Status = "Rejected",
                        Error = "Architecture rollback journal exceeds the 4,000,000-byte limit.",
                    })
                end
                addPreview({
                    Kind = "WouldUpdateSource",
                    Path = node.path,
                    BeforeSource = instance.Source,
                    AfterSource = node.source,
                    BeforeHash = sourceFingerprint(instance.Source),
                    AfterHash = sourceFingerprint(node.source),
                })
            end
        end
    end
    return HttpService:JSONEncode({
        Status = "Dry Run",
        Changes = preview,
        NonMutating = true,
        SyntaxValidation = syntaxValidation == "available" and "passed" or "unavailable",
        PlaceIdentity = {
            Name = game.Name,
            PlaceId = game.PlaceId,
            GameId = game.GameId,
            CreatorId = game.CreatorId,
        },
    })
end

local changes = {}
local undo = {}
local function record(change, undoRecord)
    table.insert(changes, change)
    table.insert(undo, undoRecord)
end

local function ensureParent(path)
    local segments = string.split(path, ".")
    local instanceName = segments[#segments]
    table.remove(segments, #segments)
    local ok, current = pcall(function() return game:GetService(segments[1]) end)
    if not ok or not current then error("Unknown root service: " .. segments[1]) end
    for index = 2, #segments do
        local child = current:FindFirstChild(segments[index])
        if not child then
            if not request.createMissingFolders then
                error("Missing parent: " .. table.concat(segments, ".", 1, index))
            end
            child = Instance.new("Folder")
            child.Name = segments[index]
            if transactionId ~= "" then child:SetAttribute("_SuperMCPTransactionId", transactionId) end
            child.Parent = current
            record(
                {
                    Kind = "CreatedInstance",
                    Path = child:GetFullName(),
                    ParentPath = current:GetFullName(),
                    Name = child.Name,
                    ClassName = "Folder",
                    TransactionMarker = transactionId,
                },
                {Kind = "DestroyInstance", Instance = child}
            )
        end
        current = child
    end
    return current, instanceName
end

local function rollback()
    local failures = {}
    for index = #undo, 1, -1 do
        local item = undo[index]
        local undoOk, undoError = pcall(function()
            if item.Kind == "DestroyInstance" then
                item.Instance:Destroy()
            elseif item.Kind == "Property" then
                item.Instance[item.Name] = item.Value
            elseif item.Kind == "Attribute" then
                item.Instance:SetAttribute(item.Name, item.Value)
            elseif item.Kind == "Source" then
                item.Instance.Source = item.Value
            elseif item.Kind == "RemoveTag" then
                CollectionService:RemoveTag(item.Instance, item.Name)
            end
        end)
        if not undoOk then
            table.insert(failures, {Index = index, Kind = item.Kind, Error = tostring(undoError)})
        end
    end
    return failures
end

local applyOk, applyError = pcall(function()
    local syntaxValidation = typeof(loadstring) == "function" and "available" or "unavailable"
    for _, node in request.nodes do
        local instance = resolvePath(node.path)
        if instance and instance.ClassName ~= node.className then
            error("Class mismatch at " .. node.path .. ": expected " .. node.className .. ", found " .. instance.ClassName)
        end
        if not instance then
            local parent, name = ensureParent(node.path)
            local createOk, created = pcall(Instance.new, node.className)
            if not createOk then error("Cannot create " .. node.className .. ": " .. tostring(created)) end
            instance = created
            instance.Name = name
            if transactionId ~= "" then instance:SetAttribute("_SuperMCPTransactionId", transactionId) end
            instance.Parent = parent
            record(
                {
                    Kind = "CreatedInstance",
                    Path = instance:GetFullName(),
                    ParentPath = parent:GetFullName(),
                    Name = instance.Name,
                    ClassName = node.className,
                    TransactionMarker = transactionId,
                },
                {Kind = "DestroyInstance", Instance = instance}
            )
        end

        for property, descriptor in node.properties do
            local before = instance[property]
            local after = decodeValue(descriptor)
            if before ~= after then
                instance[property] = after
                record(
                    {
                        Kind = "Property",
                        Path = instance:GetFullName(),
                        Name = property,
                        Before = encodeValue(before),
                        After = encodeValue(after),
                    },
                    {Kind = "Property", Instance = instance, Name = property, Value = before}
                )
            end
        end
        for attribute, descriptor in node.attributes do
            local before = instance:GetAttribute(attribute)
            local after = decodeValue(descriptor)
            if before ~= after then
                instance:SetAttribute(attribute, after)
                record(
                    {
                        Kind = "Attribute",
                        Path = instance:GetFullName(),
                        Name = attribute,
                        Before = encodeValue(before),
                        After = encodeValue(after),
                    },
                    {Kind = "Attribute", Instance = instance, Name = attribute, Value = before}
                )
            end
        end
        for _, tag in node.tags do
            if not CollectionService:HasTag(instance, tag) then
                CollectionService:AddTag(instance, tag)
                record(
                    {Kind = "Tag", Path = instance:GetFullName(), Name = tag, Before = false, After = true},
                    {Kind = "RemoveTag", Instance = instance, Name = tag}
                )
            end
        end
        if node.source ~= nil then
            if not instance:IsA("LuaSourceContainer") then error("Source supplied for non-script: " .. node.path) end
            if syntaxValidation == "available" then
                local compiled, compileError = loadstring(node.source, "=" .. node.path)
                if not compiled then error("Luau syntax validation failed: " .. tostring(compileError)) end
            end
            local before = instance.Source
            if before ~= node.source then
                instance.Source = node.source
                record(
                    {
                        Kind = "ScriptSource",
                        Path = instance:GetFullName(),
                        BeforeSource = before,
                        AfterSource = node.source,
                        BeforeHash = sourceFingerprint(before),
                        AfterHash = sourceFingerprint(node.source),
                    },
                    {Kind = "Source", Instance = instance, Value = before}
                )
            end
        end
    end
end)

if not applyOk then
    local undoFailures = rollback()
    return HttpService:JSONEncode({
        Status = #undoFailures == 0 and "Rolled Back" or "Partial Failure",
        Error = tostring(applyError),
        UndoFailures = undoFailures,
    })
end
return HttpService:JSONEncode({
    Status = #changes == 0 and "Unchanged" or "Applied",
    Changes = changes,
    SyntaxValidation = typeof(loadstring) == "function" and "passed" or "unavailable",
})
`;
    let preparedTransaction = null;
    if (args.dry_run !== true) {
        let preflight;
        try {
            const preflightCode = code.replace('"dryRun":false', '"dryRun":true');
            preflight = await executeLuau(studioCommunicator, preflightCode, {
                label: 'Architecture preflight',
                timeoutMs: 30_000
            });
        } catch (error) {
            return JSON.stringify({
                Status: 'Preflight Failed',
                error: error instanceof Error ? error.message : String(error)
            }, null, 2);
        }
        if (preflight.Status !== 'Dry Run') return JSON.stringify(preflight, null, 2);
        const preparedChanges = preflight.Changes.map(change => {
            if (change.Kind === 'WouldCreate') {
                return { ...change, Kind: 'CreatedInstance' };
            }
            if (change.Kind === 'WouldUpdateProperty') return { ...change, Kind: 'Property' };
            if (change.Kind === 'WouldUpdateAttribute') return { ...change, Kind: 'Attribute' };
            if (change.Kind === 'WouldAddTag') {
                return { Kind: 'Tag', Path: change.Path, Name: change.Name, Before: false, After: true };
            }
            if (change.Kind === 'WouldUpdateSource') return { ...change, Kind: 'ScriptSource' };
            throw new Error(`Unsupported architecture preflight change '${change.Kind}'.`);
        });
        if (preparedChanges.length === 0) {
            return JSON.stringify({
                Status: 'Unchanged',
                SyntaxValidation: preflight.SyntaxValidation,
                Changes: []
            }, null, 2);
        }
        const journalBytes = Buffer.byteLength(JSON.stringify(preparedChanges), 'utf8');
        if (journalBytes > 4_000_000) {
            return JSON.stringify({
                Status: 'Preflight Rejected',
                error: 'Rollback journal exceeds the 4,000,000-byte limit.'
            }, null, 2);
        }
        preparedTransaction = prepareTransaction({
            tool: 'create_architecture',
            idempotencyKey,
            changes: preparedChanges,
            metadata: {
                NodeCount: nodes.length,
                RequestedPaths: nodes.map(node => node.path),
                RequestHash: requestHash,
                PlaceIdentity: preflight.PlaceIdentity
            }
        });
        const markerChanges = preparedChanges.map(change => change.Kind === 'CreatedInstance'
            ? { ...change, TransactionMarker: preparedTransaction.TransactionId }
            : change);
        preparedTransaction = finalizeTransaction(preparedTransaction, {
            status: 'Prepared',
            changes: markerChanges
        });
        code = code.replace('__SUPER_MCP_TRANSACTION_ID__', preparedTransaction.TransactionId);
        for (let index = 0; index < preparedChanges.length; index += 1) {
            preparedChanges[index] = markerChanges[index];
        }
        const validationCode = `
local expectedChanges = HttpService:JSONDecode(${luaJson(preparedChanges)})
local expectedPlaceIdentity = HttpService:JSONDecode(${luaJson(preflight.PlaceIdentity)})
local preconditionsOk, preconditionsError = pcall(function()
    if game.PlaceId ~= expectedPlaceIdentity.PlaceId or game.GameId ~= expectedPlaceIdentity.GameId then
        error("Active Studio place changed after architecture preflight.")
    end
    if game.PlaceId == 0 and game.GameId == 0 and
        string.lower(game.Name) ~= string.lower(expectedPlaceIdentity.Name) then
        error("Active unpublished Studio place changed after architecture preflight.")
    end
    for _, expected in expectedChanges do
        local current = resolvePath(expected.Path)
        if expected.Kind == "CreatedInstance" then
            if current then error("Architecture precondition failed; instance now exists: " .. expected.Path) end
        elseif not current then
            error("Architecture precondition failed; instance is missing: " .. expected.Path)
        elseif expected.Kind == "ScriptSource" then
            if not current:IsA("LuaSourceContainer") or sourceFingerprint(current.Source) ~= expected.BeforeHash then
                error("Architecture source precondition failed: " .. expected.Path)
            end
        elseif expected.Kind == "Property" then
            if not descriptorsEqual(encodeValue(current[expected.Name]), expected.Before) then
                error("Architecture property precondition failed: " .. expected.Path .. "." .. expected.Name)
            end
        elseif expected.Kind == "Attribute" then
            if not descriptorsEqual(encodeValue(current:GetAttribute(expected.Name)), expected.Before) then
                error("Architecture attribute precondition failed: " .. expected.Path .. "." .. expected.Name)
            end
        elseif expected.Kind == "Tag" then
            if CollectionService:HasTag(current, expected.Name) ~= expected.Before then
                error("Architecture tag precondition failed: " .. expected.Path .. "." .. expected.Name)
            end
        end
    end
end)
if not preconditionsOk then
    return HttpService:JSONEncode({Status = "Rejected", Error = tostring(preconditionsError)})
end
`;
        code = code.replace('local changes = {}', `${validationCode}\nlocal changes = {}`);
    }

    let result;
    try {
        result = await executeLuau(studioCommunicator, code, {
            label: 'Declarative architecture creation',
            timeoutMs: 30_000
        });
    } catch (error) {
        if (preparedTransaction) {
            preparedTransaction = finalizeTransaction(preparedTransaction, {
                status: 'Uncertain',
                result: { Error: error instanceof Error ? error.message : String(error) }
            });
        }
        return JSON.stringify({
            Status: 'Mutation State Uncertain',
            error: error instanceof Error ? error.message : String(error),
            Transaction: preparedTransaction ? publicTransaction(preparedTransaction) : null,
            SuggestedAction: 'Run verify_change with this transaction ID before retrying or rolling back.'
        }, null, 2);
    }
    if (args.dry_run === true && Array.isArray(result.Changes)) {
        result.Changes = result.Changes.map(({ BeforeSource, AfterSource, ...change }) => change);
    }
    if (result.Status !== 'Applied') {
        if (preparedTransaction) {
            preparedTransaction = finalizeTransaction(preparedTransaction, {
                status: result.Status === 'Rejected' || result.Status === 'Rolled Back' ? 'Aborted' : 'Uncertain',
                result
            });
        }
        return JSON.stringify(result, null, 2);
    }

    const preparedCreatedByPath = new Map(preparedTransaction.Changes
        .filter(change => change.Kind === 'CreatedInstance')
        .map(change => [change.Path, change]));
    const finalizedChanges = result.Changes.map(change => {
        if (change.Kind !== 'CreatedInstance') return change;
        const desired = preparedCreatedByPath.get(change.Path);
        return desired ? {
            ...change,
            Properties: desired.Properties || {},
            Attributes: desired.Attributes || {},
            Tags: desired.Tags || [],
            SourceHash: desired.SourceHash || null
        } : change;
    });
    const transaction = finalizeTransaction(preparedTransaction, {
        status: 'Applied',
        changes: finalizedChanges,
        result: { SyntaxValidation: result.SyntaxValidation }
    });
    return JSON.stringify({
        Status: 'Applied',
        Transaction: publicTransaction(transaction),
        SyntaxValidation: result.SyntaxValidation,
        Summary: Object.fromEntries(['CreatedInstance', 'Property', 'Attribute', 'Tag', 'ScriptSource'].map(kind => [
            kind,
            result.Changes.filter(change => change.Kind === kind).length
        ])),
        Changes: result.Changes.map(change => change.Kind === 'ScriptSource'
            ? {
                Kind: change.Kind,
                Path: change.Path,
                BeforeHash: change.BeforeHash,
                AfterHash: change.AfterHash
            }
            : change),
        RollbackAvailable: true,
        TransactionMarkerAttribute: '_SuperMCPTransactionId is retained on created instances to prevent rollback from deleting replacements.',
        Evidence: 'live-studio + atomic-runtime-rollback'
    }, null, 2);
}
