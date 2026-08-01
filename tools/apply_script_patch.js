import {
    LUAU_PATH_RESOLVER,
    LUAU_SOURCE_FINGERPRINT,
    contentHash,
    executeLuau,
    fetchScriptSources,
    luaJson,
    sourceFingerprint
} from './studio_utils.js';
import {
    finalizeTransaction,
    findTransactionByIdempotencyKey,
    prepareTransaction,
    publicTransaction
} from './transaction_store.js';

function normalizeChanges(args) {
    const rawChanges = Array.isArray(args.changes)
        ? args.changes
        : [{ path: args.path, expected_source_hash: args.expected_source_hash, edits: args.edits }];
    if (rawChanges.length === 0 || rawChanges.length > 20) {
        throw new Error('Provide between 1 and 20 script changes.');
    }
    const changes = rawChanges.map((change, changeIndex) => {
        const path = String(change.path || '').trim();
        if (!path) throw new Error(`Change ${changeIndex + 1} is missing an exact script path.`);
        const edits = Array.isArray(change.edits) ? change.edits : [];
        if (edits.length === 0 || edits.length > 100) {
            throw new Error(`Change '${path}' must contain between 1 and 100 edits.`);
        }
        return {
            path,
            expectedSourceHash: change.expected_source_hash ? String(change.expected_source_hash) : null,
            edits: edits.map((edit, editIndex) => {
                const oldText = String(edit.old_text ?? '');
                const newText = String(edit.new_text ?? '');
                if (!oldText) throw new Error(`Edit ${editIndex + 1} for '${path}' has empty old_text.`);
                return {
                    oldText,
                    newText,
                    replaceAll: edit.replace_all === true,
                    expectedCount: Number.isSafeInteger(Number(edit.expected_count))
                        ? Number(edit.expected_count)
                        : 1
                };
            })
        };
    });
    const paths = changes.map(change => change.path);
    if (new Set(paths).size !== paths.length) {
        throw new Error('Each script path may appear only once in an atomic patch.');
    }
    return changes;
}

function applyEditsLocally(source, change) {
    let proposed = source;
    const editResults = [];
    for (let index = 0; index < change.edits.length; index += 1) {
        const edit = change.edits[index];
        let observedCount = 0;
        let cursor = 0;
        while (true) {
            const found = proposed.indexOf(edit.oldText, cursor);
            if (found < 0) break;
            observedCount += 1;
            cursor = found + edit.oldText.length;
        }
        if (observedCount !== edit.expectedCount) {
            throw new Error(
                `Edit ${index + 1} for '${change.path}' expected ${edit.expectedCount} match(es), found ${observedCount}.`
            );
        }
        const replacements = edit.replaceAll ? observedCount : 1;
        for (let replacement = 0; replacement < replacements; replacement += 1) {
            const found = proposed.indexOf(edit.oldText);
            proposed = `${proposed.slice(0, found)}${edit.newText}${proposed.slice(found + edit.oldText.length)}`;
        }
        editResults.push({ EditIndex: index + 1, Replacements: replacements });
    }
    return { proposed, editResults };
}

export async function run(args = {}, studioCommunicator) {
    let changes;
    try {
        changes = normalizeChanges(args);
    } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
    }

    const idempotencyKey = args.idempotency_key ? String(args.idempotency_key) : null;
    const requestHash = contentHash(JSON.stringify(changes));
    const patchPayloadBytes = Buffer.byteLength(JSON.stringify(changes), 'utf8');
    if (patchPayloadBytes > 2_000_000) {
        return JSON.stringify({ error: 'Patch request exceeds the 2,000,000-byte payload limit.' }, null, 2);
    }
    if (idempotencyKey && idempotencyKey.length > 200) {
        return JSON.stringify({ error: 'idempotency_key must be 200 characters or fewer.' }, null, 2);
    }
    if (args.dry_run !== true && !idempotencyKey) {
        return JSON.stringify({
            error: 'idempotency_key is required for a live patch so an uncertain/repeated call cannot duplicate the mutation.'
        }, null, 2);
    }
    if (args.dry_run !== true && changes.some(change => !change.expectedSourceHash)) {
        return JSON.stringify({
            error: 'expected_source_hash is required for every live script change. Read it with read_script_context first.'
        }, null, 2);
    }
    if (!args.dry_run && idempotencyKey) {
        const existing = findTransactionByIdempotencyKey(idempotencyKey, 'apply_script_patch');
        if (existing) {
            if (existing.Metadata?.RequestHash !== requestHash) {
                return JSON.stringify({
                    Status: 'Idempotency Conflict',
                    error: 'This idempotency_key is already bound to a different patch payload.',
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

    let preparedTransaction = null;
    if (args.dry_run !== true) {
        try {
            const sourcePreflight = await fetchScriptSources(
                studioCommunicator,
                changes.map(change => change.path),
                {
                    maxScripts: changes.length,
                    maxSourceLength: 250_000,
                    maxTotalSourceLength: 2_000_000,
                    includePlaceIdentity: true
                }
            );
            const sources = sourcePreflight.Records;
            const sourceByPath = new Map(sources.map(record => [record.Path, record]));
            const preparedChanges = changes.map(change => {
                const record = sourceByPath.get(change.path);
                if (!record || record.Truncated) throw new Error(`Full source could not be read for '${change.path}'.`);
                if (record.SourceHash !== change.expectedSourceHash) {
                    throw new Error(
                        `Source hash precondition failed for '${change.path}': expected ${change.expectedSourceHash}, found ${record.SourceHash}.`
                    );
                }
                const { proposed, editResults } = applyEditsLocally(record.Source, change);
                return {
                    Kind: 'ScriptSource',
                    Path: change.path,
                    BeforeSource: record.Source,
                    AfterSource: proposed,
                    BeforeHash: record.SourceHash,
                    AfterHash: sourceFingerprint(proposed),
                    BeforeLength: Buffer.byteLength(record.Source, 'utf8'),
                    AfterLength: Buffer.byteLength(proposed, 'utf8'),
                    EditResults: editResults
                };
            });
            const journalBytes = preparedChanges.reduce(
                (total, change) => total + change.BeforeLength + change.AfterLength,
                0
            );
            if (journalBytes > 4_000_000) throw new Error('Rollback journal exceeds the 4,000,000-byte limit.');
            preparedTransaction = prepareTransaction({
                tool: 'apply_script_patch',
                idempotencyKey,
                changes: preparedChanges,
                metadata: {
                    ScriptCount: preparedChanges.length,
                    Paths: preparedChanges.map(change => change.Path),
                    RequestHash: requestHash,
                    PlaceIdentity: sourcePreflight.PlaceIdentity
                }
            });
        } catch (error) {
            return JSON.stringify({
                Status: 'Preflight Rejected',
                error: error instanceof Error ? error.message : String(error)
            }, null, 2);
        }
    }

    const code = `
local HttpService = game:GetService("HttpService")
${LUAU_PATH_RESOLVER}
${LUAU_SOURCE_FINGERPRINT}
local request = HttpService:JSONDecode(${luaJson({
        changes,
        dryRun: args.dry_run === true,
        maxTotalSourceBytes: 2_000_000,
        expectedPlaceIdentity: preparedTransaction?.Metadata?.PlaceIdentity || null
    })})

local function placeMatches(expected)
    if expected == nil then return true end
    if game.PlaceId ~= expected.PlaceId or game.GameId ~= expected.GameId then return false end
    if game.PlaceId == 0 and game.GameId == 0 then
        return string.lower(game.Name) == string.lower(expected.Name)
    end
    return true
end
if not placeMatches(request.expectedPlaceIdentity) then
    return HttpService:JSONEncode({
        Status = "Rejected",
        Error = "Active Studio place changed after patch preflight.",
    })
end

local function countOccurrences(source, needle)
    local count = 0
    local cursor = 1
    while true do
        local first, last = string.find(source, needle, cursor, true)
        if not first then break end
        count += 1
        cursor = math.max(last + 1, first + 1)
    end
    return count
end

local function replaceFirst(source, oldText, newText)
    local first, last = string.find(source, oldText, 1, true)
    if not first then return source end
    return string.sub(source, 1, first - 1) .. newText .. string.sub(source, last + 1)
end

local proposals = {}
local totalSourceBytes = 0
local syntaxValidation = typeof(loadstring) == "function" and "available" or "unavailable"
for _, change in request.changes do
    local instance = resolvePath(change.path)
    if not instance or not instance:IsA("LuaSourceContainer") then
        return HttpService:JSONEncode({Status = "Rejected", Error = "Script not found: " .. change.path})
    end
    local readOk, source = pcall(function() return instance.Source end)
    if not readOk then
        return HttpService:JSONEncode({Status = "Rejected", Error = "Source is unreadable: " .. change.path})
    end
    totalSourceBytes += #source
    if totalSourceBytes > request.maxTotalSourceBytes then
        return HttpService:JSONEncode({
            Status = "Rejected",
            Error = "Patch source payload exceeds the 2,000,000-byte transaction limit.",
        })
    end
    local beforeHash = sourceFingerprint(source)
    if change.expectedSourceHash and change.expectedSourceHash ~= beforeHash then
        return HttpService:JSONEncode({
            Status = "Rejected",
            Error = "Source hash precondition failed: " .. change.path,
            ExpectedSourceHash = change.expectedSourceHash,
            ActualSourceHash = beforeHash,
        })
    end

    local proposed = source
    local editResults = {}
    for editIndex, edit in change.edits do
        local observedCount = countOccurrences(proposed, edit.oldText)
        if observedCount ~= edit.expectedCount then
            return HttpService:JSONEncode({
                Status = "Rejected",
                Error = "Edit match-count precondition failed: " .. change.path,
                EditIndex = editIndex,
                ExpectedCount = edit.expectedCount,
                ObservedCount = observedCount,
            })
        end
        if edit.replaceAll then
            for _ = 1, observedCount do
                proposed = replaceFirst(proposed, edit.oldText, edit.newText)
            end
        else
            proposed = replaceFirst(proposed, edit.oldText, edit.newText)
        end
        table.insert(editResults, {
            EditIndex = editIndex,
            Replacements = edit.replaceAll and observedCount or 1,
        })
    end
    if syntaxValidation == "available" then
        local compiled, compileError = loadstring(proposed, "=" .. change.path)
        if not compiled then
            return HttpService:JSONEncode({
                Status = "Rejected",
                Error = "Luau syntax validation failed: " .. change.path,
                SyntaxError = tostring(compileError),
            })
        end
    end
    table.insert(proposals, {
        Instance = instance,
        Path = change.path,
        BeforeSource = source,
        AfterSource = proposed,
        BeforeHash = beforeHash,
        AfterHash = sourceFingerprint(proposed),
        EditResults = editResults,
    })
end

if request.dryRun then
    local preview = {}
    for _, proposal in proposals do
        table.insert(preview, {
            Path = proposal.Path,
            BeforeHash = proposal.BeforeHash,
            AfterHash = proposal.AfterHash,
            BeforeLength = #proposal.BeforeSource,
            AfterLength = #proposal.AfterSource,
            EditResults = proposal.EditResults,
        })
    end
    return HttpService:JSONEncode({
        Status = "Dry Run",
        Changes = preview,
        SyntaxValidation = syntaxValidation == "available" and "passed" or "unavailable",
    })
end

local written = {}
local commitOk, commitError = pcall(function()
    for _, proposal in proposals do
        proposal.Instance.Source = proposal.AfterSource
        table.insert(written, proposal)
        if sourceFingerprint(proposal.Instance.Source) ~= proposal.AfterHash then
            error("Post-write verification failed: " .. proposal.Path)
        end
    end
end)
if not commitOk then
    for index = #written, 1, -1 do
        pcall(function()
            written[index].Instance.Source = written[index].BeforeSource
        end)
    end
    return HttpService:JSONEncode({Status = "Rolled Back", Error = tostring(commitError)})
end

local resultChanges = {}
for _, proposal in proposals do
    table.insert(resultChanges, {
        Kind = "ScriptSource",
        Path = proposal.Path,
        BeforeSource = proposal.BeforeSource,
        AfterSource = proposal.AfterSource,
        BeforeHash = proposal.BeforeHash,
        AfterHash = proposal.AfterHash,
        BeforeLength = #proposal.BeforeSource,
        AfterLength = #proposal.AfterSource,
        EditResults = proposal.EditResults,
    })
end
return HttpService:JSONEncode({
    Status = "Applied",
    Changes = resultChanges,
    SyntaxValidation = syntaxValidation == "available" and "passed" or "unavailable",
})
`;

    let result;
    try {
        result = await executeLuau(studioCommunicator, code, {
            label: 'Atomic script patch',
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
    if (result.Status !== 'Applied' || args.dry_run === true) {
        if (preparedTransaction) {
            preparedTransaction = finalizeTransaction(preparedTransaction, {
                status: result.Status === 'Rejected' || result.Status === 'Rolled Back' ? 'Aborted' : 'Uncertain',
                result
            });
        }
        return JSON.stringify(result, null, 2);
    }

    const transaction = finalizeTransaction(preparedTransaction, {
        status: 'Applied',
        changes: result.Changes,
        result: { SyntaxValidation: result.SyntaxValidation }
    });
    return JSON.stringify({
        Status: 'Applied and State Verified',
        Transaction: publicTransaction(transaction),
        SyntaxValidation: result.SyntaxValidation,
        Changes: result.Changes.map(change => ({
            Path: change.Path,
            BeforeHash: change.BeforeHash,
            AfterHash: change.AfterHash,
            BeforeLength: change.BeforeLength,
            AfterLength: change.AfterLength,
            EditResults: change.EditResults
        })),
        RollbackAvailable: true,
        Evidence: 'live-source-precondition + post-write-verification'
    }, null, 2);
}
