import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TRANSACTION_DIRECTORY = process.env.ROBLOX_SUPER_MCP_TRANSACTION_PATH ||
    path.join(__dirname, '..', '.transactions');

function ensureDirectory() {
    fs.mkdirSync(TRANSACTION_DIRECTORY, { recursive: true });
}

function transactionPath(id) {
    const safeId = String(id || '');
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(safeId)) throw new Error('Invalid transaction ID.');
    return path.join(TRANSACTION_DIRECTORY, `${safeId}.json`);
}

export function createTransaction({
    tool,
    idempotencyKey = null,
    changes,
    metadata = {}
}) {
    const transaction = prepareTransaction({ tool, idempotencyKey, changes, metadata });
    return finalizeTransaction(transaction, { status: 'Applied', changes });
}

export function prepareTransaction({
    tool,
    idempotencyKey = null,
    changes,
    metadata = {}
}) {
    ensureDirectory();
    const transaction = {
        SchemaVersion: 1,
        TransactionId: randomUUID(),
        Tool: String(tool),
        IdempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        CreatedAt: new Date().toISOString(),
        Status: 'Prepared',
        Changes: Array.isArray(changes) ? changes : [],
        Metadata: metadata
    };
    writeTransaction(transaction);
    return transaction;
}

export function finalizeTransaction(transaction, {
    status = 'Applied',
    changes = transaction.Changes,
    metadata = transaction.Metadata,
    result = undefined
} = {}) {
    const updated = {
        ...transaction,
        Status: status,
        Changes: Array.isArray(changes) ? changes : transaction.Changes,
        Metadata: metadata,
        UpdatedAt: new Date().toISOString(),
        ...(result === undefined ? {} : { Result: result })
    };
    writeTransaction(updated);
    return updated;
}

export function writeTransaction(transaction) {
    ensureDirectory();
    const destination = transactionPath(transaction.TransactionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(transaction, null, 2), 'utf8');
        fs.renameSync(temporary, destination);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export function loadTransaction(id) {
    try {
        const value = JSON.parse(fs.readFileSync(transactionPath(id), 'utf8'));
        return { ok: true, transaction: value };
    } catch (error) {
        return {
            ok: false,
            error: `Transaction '${id}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

export function findTransactionByIdempotencyKey(key, tool) {
    const wanted = String(key || '');
    if (!wanted || !fs.existsSync(TRANSACTION_DIRECTORY)) return null;
    for (const entry of fs.readdirSync(TRANSACTION_DIRECTORY, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
            const transaction = JSON.parse(fs.readFileSync(path.join(TRANSACTION_DIRECTORY, entry.name), 'utf8'));
            if (transaction.IdempotencyKey === wanted && transaction.Tool === tool &&
                ['Applied', 'Prepared', 'Uncertain'].includes(transaction.Status)) {
                return transaction;
            }
        } catch {
            // A damaged transaction must not prevent unrelated operations.
        }
    }
    return null;
}

export function markRolledBack(transaction, result) {
    const updated = {
        ...transaction,
        Status: 'RolledBack',
        RolledBackAt: new Date().toISOString(),
        RollbackResult: result
    };
    writeTransaction(updated);
    return updated;
}

export function publicTransaction(transaction) {
    return {
        TransactionId: transaction.TransactionId,
        Tool: transaction.Tool,
        IdempotencyKey: transaction.IdempotencyKey,
        CreatedAt: transaction.CreatedAt,
        Status: transaction.Status,
        ChangeCount: transaction.Changes?.length || 0,
        Metadata: transaction.Metadata || {}
    };
}
