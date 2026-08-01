import {
    LUAU_PATH_RESOLVER,
    LUAU_SOURCE_FINGERPRINT,
    executeLuau,
    fetchPlaceIdentity,
    luaJson
} from './studio_utils.js';
import { placeIdentitiesMatch } from './brain_store.js';
import {
    loadTransaction,
    markRolledBack,
    publicTransaction
} from './transaction_store.js';

export async function run(args = {}, studioCommunicator) {
    const transactionId = String(args.transaction_id || '').trim();
    if (!transactionId) return JSON.stringify({ error: 'Provide transaction_id.' });
    const loaded = loadTransaction(transactionId);
    if (!loaded.ok) return JSON.stringify({ error: loaded.error }, null, 2);
    const transaction = loaded.transaction;
    if (transaction.Status === 'RolledBack' && args.force !== true) {
        return JSON.stringify({
            Status: 'Already Rolled Back',
            Transaction: publicTransaction(transaction)
        }, null, 2);
    }
    const boundPlace = transaction.Metadata?.PlaceIdentity;
    if (!boundPlace) {
        return JSON.stringify({
            Status: 'Rejected',
            Transaction: publicTransaction(transaction),
            Reason: 'Legacy transaction has no bound Studio place identity.'
        }, null, 2);
    }
    let livePlace;
    try {
        livePlace = await fetchPlaceIdentity(studioCommunicator);
    } catch (error) {
        return JSON.stringify({
            Status: 'Rejected',
            Transaction: publicTransaction(transaction),
            Reason: error instanceof Error ? error.message : String(error)
        }, null, 2);
    }
    if (!placeIdentitiesMatch(boundPlace, livePlace)) {
        return JSON.stringify({
            Status: 'Rejected',
            Transaction: publicTransaction(transaction),
            Reason: 'The active Studio place does not match this transaction.',
            BoundPlace: boundPlace,
            LivePlace: livePlace
        }, null, 2);
    }

    const code = `
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
${LUAU_PATH_RESOLVER}
${LUAU_SOURCE_FINGERPRINT}
local request = HttpService:JSONDecode(${luaJson({
        changes: transaction.Changes,
        force: args.force === true,
        dryRun: args.dry_run === true,
        boundPlace
    })})

if game.PlaceId ~= request.boundPlace.PlaceId or game.GameId ~= request.boundPlace.GameId or
    (game.PlaceId == 0 and game.GameId == 0 and string.lower(game.Name) ~= string.lower(request.boundPlace.Name)) then
    return HttpService:JSONEncode({
        Status = "Rejected",
        Reason = "The active Studio place changed during rollback.",
    })
end

local function encodeValue(value)
    local kind = typeof(value)
    if value == nil then return {Type = "Nil"} end
    if kind == "string" or kind == "number" or kind == "boolean" then return {Type = kind, Value = value} end
    if kind == "Vector2" then return {Type = kind, Value = {value.X, value.Y}} end
    if kind == "Vector3" then return {Type = kind, Value = {value.X, value.Y, value.Z}} end
    if kind == "Color3" then return {Type = kind, Value = {value.R, value.G, value.B}} end
    if kind == "CFrame" then return {Type = kind, Value = {value:GetComponents()}} end
    if kind == "UDim" then return {Type = kind, Value = {value.Scale, value.Offset}} end
    if kind == "UDim2" then return {Type = kind, Value = {value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset}} end
    if kind == "EnumItem" then return {Type = kind, Value = tostring(value)} end
    if kind == "Instance" then return {Type = kind, Value = value:GetFullName()} end
    return {Type = "Unsupported", Value = tostring(value)}
end

local function descriptorsEqual(left, right)
    return HttpService:JSONEncode(left) == HttpService:JSONEncode(right)
end

local function decodeValue(descriptor)
    if typeof(descriptor) ~= "table" or descriptor.Type == nil then return descriptor end
    local kind, value = descriptor.Type, descriptor.Value
    if kind == "Nil" then return nil end
    if kind == "Vector2" then return Vector2.new(value[1], value[2]) end
    if kind == "Vector3" then return Vector3.new(value[1], value[2], value[3]) end
    if kind == "Color3" then return Color3.new(value[1], value[2], value[3]) end
    if kind == "CFrame" then return CFrame.new(table.unpack(value)) end
    if kind == "UDim" then return UDim.new(value[1], value[2]) end
    if kind == "UDim2" then return UDim2.new(value[1], value[2], value[3], value[4]) end
    if kind == "EnumItem" then
        local parts = string.split(value, ".")
        return Enum[parts[2]][parts[3]]
    end
    if kind == "Instance" then return resolvePath(value) end
    return value
end

local conflicts = {}
for _, change in request.changes do
    local instance = resolvePath(change.Path)
    if change.Kind == "ScriptSource" then
        if not instance or not instance:IsA("LuaSourceContainer") then
            table.insert(conflicts, {Path = change.Path, Reason = "Script missing"})
        elseif not request.force and sourceFingerprint(instance.Source) ~= change.AfterHash then
            table.insert(conflicts, {
                Path = change.Path,
                Reason = "Source drift",
                ExpectedHash = change.AfterHash,
                ActualHash = sourceFingerprint(instance.Source),
            })
        end
    elseif change.Kind == "CreatedInstance" and not instance then
        table.insert(conflicts, {Path = change.Path, Reason = "Created instance is already missing"})
    elseif change.Kind == "CreatedInstance" and not request.force and change.TransactionMarker and
        instance:GetAttribute("_SuperMCPTransactionId") ~= change.TransactionMarker then
        table.insert(conflicts, {Path = change.Path, Reason = "Created instance identity marker changed"})
    elseif change.Kind ~= "CreatedInstance" and not instance then
        table.insert(conflicts, {Path = change.Path, Reason = "Instance missing"})
    elseif change.Kind == "Property" and not request.force then
        local readOk, value = pcall(function() return instance[change.Name] end)
        if not readOk or not descriptorsEqual(encodeValue(value), change.After) then
            table.insert(conflicts, {Path = change.Path, Reason = "Property drift", Name = change.Name})
        end
    elseif change.Kind == "Attribute" and not request.force then
        if not descriptorsEqual(encodeValue(instance:GetAttribute(change.Name)), change.After) then
            table.insert(conflicts, {Path = change.Path, Reason = "Attribute drift", Name = change.Name})
        end
    elseif change.Kind == "Tag" and not request.force then
        if CollectionService:HasTag(instance, change.Name) ~= change.After then
            table.insert(conflicts, {Path = change.Path, Reason = "Tag drift", Name = change.Name})
        end
    end
end
if #conflicts > 0 then
    return HttpService:JSONEncode({Status = "Rejected", Conflicts = conflicts})
end
if request.dryRun then
    return HttpService:JSONEncode({Status = "Dry Run", ReversibleChanges = #request.changes})
end

local applied = {}
local appliedChanges = {}
local restoredInstances = {}
local function resolveCurrent(path)
    return restoredInstances[path] or resolvePath(path)
end
local function applyAfter(change)
    local instance = resolveCurrent(change.Path)
    if change.Kind == "CreatedInstance" then
        if instance then return end
        local parent = resolveCurrent(change.ParentPath)
        if not parent then error("Cannot restore parent: " .. tostring(change.ParentPath)) end
        instance = Instance.new(change.ClassName)
        instance.Name = change.Name
        if change.TransactionMarker then
            instance:SetAttribute("_SuperMCPTransactionId", change.TransactionMarker)
        end
        instance.Parent = parent
        restoredInstances[change.Path] = instance
    elseif change.Kind == "ScriptSource" then
        instance.Source = change.AfterSource
    elseif change.Kind == "Property" then
        instance[change.Name] = decodeValue(change.After)
    elseif change.Kind == "Attribute" then
        instance:SetAttribute(change.Name, decodeValue(change.After))
    elseif change.Kind == "Tag" then
        if change.After then
            CollectionService:AddTag(instance, change.Name)
        else
            CollectionService:RemoveTag(instance, change.Name)
        end
    end
end

local rollbackOk, rollbackError = pcall(function()
    for index = #request.changes, 1, -1 do
        local change = request.changes[index]
        local instance = resolvePath(change.Path)
        if change.Kind == "ScriptSource" then
            instance.Source = change.BeforeSource
        elseif change.Kind == "Property" then
            instance[change.Name] = decodeValue(change.Before)
        elseif change.Kind == "Attribute" then
            instance:SetAttribute(change.Name, decodeValue(change.Before))
        elseif change.Kind == "Tag" then
            if change.Before then
                CollectionService:AddTag(instance, change.Name)
            else
                CollectionService:RemoveTag(instance, change.Name)
            end
        elseif change.Kind == "CreatedInstance" and instance then
            instance:Destroy()
        end
        table.insert(applied, {Kind = change.Kind, Path = change.Path})
        table.insert(appliedChanges, change)
    end
end)
if not rollbackOk then
    local compensationFailures = {}
    for index = #appliedChanges, 1, -1 do
        local compensationOk, compensationError = pcall(applyAfter, appliedChanges[index])
        if not compensationOk then
            table.insert(compensationFailures, {
                Kind = appliedChanges[index].Kind,
                Path = appliedChanges[index].Path,
                Error = tostring(compensationError),
            })
        end
    end
    return HttpService:JSONEncode({
        Status = #compensationFailures == 0 and "Rollback Failed; After State Restored" or "Partial Failure",
        Error = tostring(rollbackError),
        Applied = applied,
        CompensationFailures = compensationFailures,
    })
end

local createdPaths = {}
for _, change in request.changes do
    if change.Kind == "CreatedInstance" then createdPaths[change.Path] = true end
end
local verification = {}
local verified = true
for _, change in request.changes do
    local instance = resolvePath(change.Path)
    local passed = false
    if createdPaths[change.Path] then
        passed = instance == nil
    elseif change.Kind == "ScriptSource" then
        passed = instance ~= nil and instance:IsA("LuaSourceContainer") and
            sourceFingerprint(instance.Source) == change.BeforeHash
    elseif change.Kind == "Property" and instance then
        local readOk, value = pcall(function() return instance[change.Name] end)
        passed = readOk and descriptorsEqual(encodeValue(value), change.Before)
    elseif change.Kind == "Attribute" and instance then
        passed = descriptorsEqual(encodeValue(instance:GetAttribute(change.Name)), change.Before)
    elseif change.Kind == "Tag" and instance then
        passed = CollectionService:HasTag(instance, change.Name) == change.Before
    end
    if not passed then verified = false end
    table.insert(verification, {Kind = change.Kind, Path = change.Path, Passed = passed})
end
return HttpService:JSONEncode({
    Status = verified and "Rolled Back" or "Rollback Verification Failed",
    Applied = applied,
    Verification = verification,
})
`;
    const result = await executeLuau(studioCommunicator, code, {
        label: 'Transaction rollback',
        timeoutMs: 30_000
    });
    if (result.Status !== 'Rolled Back' || args.dry_run === true) {
        return JSON.stringify(result, null, 2);
    }
    const updated = markRolledBack(transaction, result);
    return JSON.stringify({
        Status: 'Rolled Back',
        Transaction: publicTransaction(updated),
        RevertedChanges: result.Applied,
        Verification: result.Verification,
        PlaceIdentity: livePlace,
        Evidence: 'live-precondition + reverse-order-reversion + post-rollback-verification'
    }, null, 2);
}
