import assert from 'node:assert/strict';
import {
    loadBrain,
    cacheMetadata,
    placeIdentitiesMatch
} from './brain_store.js';
import {
    LUAU_PATH_RESOLVER,
    LUAU_SOURCE_FINGERPRINT,
    executeLuau,
    fetchPlaceIdentity,
    luaJson
} from './studio_utils.js';
import {
    finalizeTransaction,
    loadTransaction,
    publicTransaction
} from './transaction_store.js';
import * as sanityCheckScript from './sanity_check_script.js';

function valuesEqual(left, right) {
    try {
        assert.deepEqual(left, right);
        return true;
    } catch {
        return false;
    }
}

export async function run(args = {}, studioCommunicator) {
    const transactionId = String(args.transaction_id || '').trim();
    if (!transactionId) return JSON.stringify({ error: 'Provide transaction_id.' });
    const loadedTransaction = loadTransaction(transactionId);
    if (!loadedTransaction.ok) return JSON.stringify({ error: loadedTransaction.error }, null, 2);
    let transaction = loadedTransaction.transaction;
    if (!Array.isArray(transaction.Changes) || transaction.Changes.length === 0) {
        return JSON.stringify({
            Status: 'UNVERIFIABLE',
            Transaction: publicTransaction(transaction),
            Reason: 'The transaction contains no reversible state records.'
        }, null, 2);
    }
    const boundPlace = transaction.Metadata?.PlaceIdentity;
    if (!boundPlace) {
        return JSON.stringify({
            Status: 'REJECTED',
            Transaction: publicTransaction(transaction),
            Reason: 'Legacy transaction has no bound Studio place identity.'
        }, null, 2);
    }
    let livePlace;
    try {
        livePlace = await fetchPlaceIdentity(studioCommunicator);
    } catch (error) {
        return JSON.stringify({
            Status: 'REJECTED',
            Transaction: publicTransaction(transaction),
            Reason: error instanceof Error ? error.message : String(error)
        }, null, 2);
    }
    if (!placeIdentitiesMatch(boundPlace, livePlace)) {
        return JSON.stringify({
            Status: 'REJECTED',
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
local changes = HttpService:JSONDecode(${luaJson(transaction.Changes)})
local boundPlace = HttpService:JSONDecode(${luaJson(boundPlace)})
if game.PlaceId ~= boundPlace.PlaceId or game.GameId ~= boundPlace.GameId or
    (game.PlaceId == 0 and game.GameId == 0 and string.lower(game.Name) ~= string.lower(boundPlace.Name)) then
    return HttpService:JSONEncode({PlaceMismatch = true})
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

local results = {}
for index, change in changes do
    local instance = resolvePath(change.Path)
    local result = {Index = index, Kind = change.Kind, Path = change.Path, Exists = instance ~= nil}
    if change.Kind == "ScriptSource" and instance and instance:IsA("LuaSourceContainer") then
        result.ObservedHash = sourceFingerprint(instance.Source)
        result.ExpectedHash = change.AfterHash
        result.Source = instance.Source
    elseif change.Kind == "CreatedInstance" then
        result.ExpectedExists = true
        result.ObservedClassName = instance and instance.ClassName or nil
        result.ExpectedClassName = change.ClassName
        result.ObservedTransactionMarker = instance and instance:GetAttribute("_SuperMCPTransactionId") or nil
        result.ExpectedTransactionMarker = change.TransactionMarker
        result.ObservedProperties = {}
        result.ExpectedProperties = change.Properties or {}
        result.ObservedAttributes = {}
        result.ExpectedAttributes = change.Attributes or {}
        result.ObservedTags = {}
        result.ExpectedTags = change.Tags or {}
        if instance then
            for name, _ in result.ExpectedProperties do
                local ok, value = pcall(function() return instance[name] end)
                result.ObservedProperties[name] = ok and encodeValue(value) or {Type = "ReadError"}
            end
            for name, _ in result.ExpectedAttributes do
                result.ObservedAttributes[name] = encodeValue(instance:GetAttribute(name))
            end
            for _, tag in result.ExpectedTags do
                result.ObservedTags[tag] = CollectionService:HasTag(instance, tag)
            end
            if change.SourceHash and instance:IsA("LuaSourceContainer") then
                result.ObservedSourceHash = sourceFingerprint(instance.Source)
                result.ExpectedSourceHash = change.SourceHash
            end
        end
    elseif change.Kind == "Property" and instance then
        local ok, value = pcall(function() return instance[change.Name] end)
        result.Observed = ok and encodeValue(value) or {Type = "ReadError"}
        result.Expected = change.After
    elseif change.Kind == "Attribute" and instance then
        result.Observed = encodeValue(instance:GetAttribute(change.Name))
        result.Expected = change.After
    elseif change.Kind == "Tag" and instance then
        result.Observed = CollectionService:HasTag(instance, change.Name)
        result.Expected = change.After
    end
    table.insert(results, result)
end
return HttpService:JSONEncode(results)
`;
    const observations = await executeLuau(studioCommunicator, code, {
        label: 'Transaction verification',
        timeoutMs: 30_000
    });
    if (!Array.isArray(observations) || observations.PlaceMismatch) {
        return JSON.stringify({
            Status: 'REJECTED',
            Transaction: publicTransaction(transaction),
            Reason: 'The active Studio place changed during verification.'
        }, null, 2);
    }
    const checks = observations.map(observation => {
        const change = transaction.Changes[Number(observation.Index) - 1];
        let matchesAfter = false;
        let matchesBefore = false;
        if (observation.Kind === 'ScriptSource') {
            matchesAfter = observation.ObservedHash === change?.AfterHash;
            matchesBefore = observation.ObservedHash === change?.BeforeHash;
        }
        else if (observation.Kind === 'CreatedInstance') {
            matchesAfter = observation.Exists === true &&
                (!observation.ExpectedClassName || observation.ObservedClassName === observation.ExpectedClassName) &&
                (!observation.ExpectedTransactionMarker ||
                    observation.ObservedTransactionMarker === observation.ExpectedTransactionMarker) &&
                valuesEqual(observation.ObservedProperties || {}, observation.ExpectedProperties || {}) &&
                valuesEqual(observation.ObservedAttributes || {}, observation.ExpectedAttributes || {}) &&
                Object.values(observation.ObservedTags || {}).every(Boolean) &&
                (!observation.ExpectedSourceHash ||
                    observation.ObservedSourceHash === observation.ExpectedSourceHash);
            matchesBefore = observation.Exists === false;
        } else if (['Property', 'Attribute'].includes(observation.Kind)) {
            matchesAfter = observation.Exists === true && valuesEqual(observation.Observed, change?.After);
            matchesBefore = observation.Exists === true && valuesEqual(observation.Observed, change?.Before);
        } else if (observation.Kind === 'Tag') {
            matchesAfter = observation.Exists === true && observation.Observed === change?.After;
            matchesBefore = observation.Exists === true && observation.Observed === change?.Before;
        }
        return {
            ...observation,
            Source: undefined,
            State: matchesAfter ? 'AFTER' : matchesBefore ? 'BEFORE' : 'DRIFT',
            Passed: matchesAfter
        };
    });

    const sourceAudits = [];
    for (const observation of observations.filter((item, index) =>
        item.Kind === 'ScriptSource' && item.Source && checks[index]?.State === 'AFTER'
    )) {
        const audit = JSON.parse(await sanityCheckScript.run({
            script_name: observation.Path,
            script_content: observation.Source
        }));
        sourceAudits.push({
            Path: observation.Path,
            Status: audit.Status,
            Score: audit.Score,
            Summary: audit.Summary,
            Findings: audit.Findings
        });
    }
    const brain = loadBrain();
    const indexedPaths = brain.ok ? new Set(brain.brain.AllItems.map(item => item.Path)) : new Set();
    const affectedPaths = [...new Set(transaction.Changes.map(change => change.Path))];
    const allAfter = checks.length > 0 && checks.every(check => check.State === 'AFTER');
    const allBefore = checks.length > 0 && checks.every(check => check.State === 'BEFORE');
    const hasDrift = checks.some(check => check.State === 'DRIFT');
    const auditReviewRequired = sourceAudits.some(audit => audit.Status !== 'PASS');
    let status = hasDrift ? 'DRIFT DETECTED'
        : allAfter ? (auditReviewRequired ? 'STATE VERIFIED; CODE REVIEW REQUIRED' : 'VERIFIED')
            : allBefore ? 'NOT APPLIED'
                : 'PARTIALLY APPLIED';
    if (['Prepared', 'Uncertain'].includes(transaction.Status) && (allAfter || allBefore)) {
        transaction = finalizeTransaction(transaction, {
            status: allAfter ? 'Applied' : 'Aborted',
            result: {
                ReconciledBy: 'verify_change',
                ReconciledAt: new Date().toISOString(),
                State: allAfter ? 'AFTER' : 'BEFORE'
            }
        });
        status = allAfter
            ? (auditReviewRequired ? 'STATE VERIFIED; CODE REVIEW REQUIRED' : 'VERIFIED')
            : 'NOT APPLIED';
    }

    return JSON.stringify({
        Status: status,
        Transaction: publicTransaction(transaction),
        Checks: checks,
        Summary: {
            After: checks.filter(check => check.State === 'AFTER').length,
            Before: checks.filter(check => check.State === 'BEFORE').length,
            Drift: checks.filter(check => check.State === 'DRIFT').length
        },
        SourceAudits: sourceAudits,
        IndexIntegrity: {
            Cache: brain.ok ? cacheMetadata(brain.brain, brain.staleSchema) : { Error: brain.error },
            AffectedPathsMissingFromIndex: affectedPaths.filter(path => !indexedPaths.has(path)),
            NeedsRescan: transaction.Changes.some(change => change.Kind === 'ScriptSource') ||
                transaction.Tool === 'create_architecture' ||
                affectedPaths.some(path => !indexedPaths.has(path))
        },
        Evidence: 'live-postcondition + static-source-audit',
        PlaceIdentity: livePlace
    }, null, 2);
}
