import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BRAIN_PATH = process.env.ROBLOX_SUPER_MCP_BRAIN_PATH ||
    path.join(__dirname, '..', 'project_brain.json');
export const BRAIN_SCHEMA_VERSION = 4;

export function loadBrain() {
    if (!fs.existsSync(BRAIN_PATH)) {
        return { ok: false, error: "Project Brain not found. Run 'analyze_project' first." };
    }

    try {
        const brain = JSON.parse(fs.readFileSync(BRAIN_PATH, 'utf8'));
        if (!brain || !Array.isArray(brain.AllItems)) {
            return { ok: false, error: "Project Brain is invalid. Run 'analyze_project' to rebuild it." };
        }

        return {
            ok: true,
            brain: {
                ...brain,
                SchemaVersion: Number(brain.SchemaVersion || 1),
                AllItems: brain.AllItems.map(normalizeItem)
            },
            staleSchema: Number(brain.SchemaVersion || 1) < BRAIN_SCHEMA_VERSION ||
                !isValidPlaceIdentity(brain.PlaceIdentity)
        };
    } catch (error) {
        return {
            ok: false,
            error: `Project Brain could not be read: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

export function saveBrain(brain) {
    if (!brain || !Array.isArray(brain.AllItems) || !brain.PlaceIdentity) {
        throw new Error('Refusing to replace the Project Brain without a valid item array and place identity.');
    }
    const normalized = {
        ...brain,
        SchemaVersion: BRAIN_SCHEMA_VERSION,
        AllItems: (brain.AllItems || []).map(normalizeItem)
    };
    const temporaryPath = `${BRAIN_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 2));
        fs.renameSync(temporaryPath, BRAIN_PATH);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

export function normalizeItem(item) {
    return {
        ...item,
        Name: String(item.Name || ''),
        Class: String(item.Class || item.ClassName || ''),
        Path: String(item.Path || item.FullName || ''),
        Category: String(item.Category || ''),
        Requires: arrayOfStrings(item.Requires),
        ServicesUsed: arrayOfStrings(item.ServicesUsed),
        SearchTerms: arrayOfStrings(item.SearchTerms),
        RemoteUsage: normalizeRecords(item.RemoteUsage, ['Name', 'Method', 'Symbol', 'Line'])
            .map(record => ({ ...record, Line: finiteNonNegative(record.Line) })),
        DataStoreUsage: normalizeRecords(item.DataStoreUsage, ['Name', 'Method']),
        Attributes: arrayOfStrings(item.Attributes),
        AttributeUsage: normalizeRecords(item.AttributeUsage, ['Name', 'Method']),
        Functions: arrayOfStrings(item.Functions),
        Calls: arrayOfStrings(item.Calls),
        SourceHash: String(item.SourceHash || ''),
        SourceLength: finiteNonNegative(item.SourceLength),
        SourceLines: finiteNonNegative(item.SourceLines),
        LifecycleOwner: String(item.LifecycleOwner || ''),
        HasTrackedCancellation: item.HasTrackedCancellation === true,
        UsesNetworkOwnership: item.UsesNetworkOwnership === true,
        WritesAnchored: item.WritesAnchored === true,
        UsesHotSignal: item.UsesHotSignal === true,
        EvidenceQuality: String(item.EvidenceQuality || 'legacy-regex')
    };
}

export function cacheMetadata(brain, staleSchema = false) {
    return {
        SchemaVersion: brain.SchemaVersion,
        ScannedAt: brain.ScannedAt || null,
        SourceMetadataAvailable: brain.AllItems.some(item =>
            item.Requires.length > 0 ||
            item.ServicesUsed.length > 0 ||
            item.RemoteUsage.length > 0 ||
            item.Functions.length > 0
        ),
        NeedsRescan: staleSchema,
        IndexedItems: brain.AllItems.length,
        ProjectFingerprint: projectFingerprint(brain.AllItems),
        PlaceIdentity: brain.PlaceIdentity || null,
        PlaceBound: Boolean(brain.PlaceIdentity && Number.isFinite(Number(brain.PlaceIdentity.PlaceId)))
    };
}

function arrayOfStrings(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(entry => String(entry || '').trim()).filter(Boolean))];
}

function normalizeRecords(value, keys) {
    if (!Array.isArray(value)) return [];
    return value
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => Object.fromEntries(keys.map(key => [key, String(entry[key] || '')])))
        .filter(entry => entry[keys[0]]);
}

function finiteNonNegative(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function projectFingerprint(items) {
    let checksum = 0;
    const signatures = items
        .map(item => `${item.Path}:${item.Class}:${item.SourceHash || ''}`)
        .sort();
    for (const signature of signatures) {
        for (let index = 0; index < signature.length; index += 1) {
            checksum = (checksum + signature.charCodeAt(index) * ((index % 251) + 1)) % 2_147_483_647;
        }
    }
    return `${items.length}:${checksum}`;
}

function isValidPlaceIdentity(identity) {
    if (!identity || !Number.isFinite(Number(identity.PlaceId)) || !Number.isFinite(Number(identity.GameId))) {
        return false;
    }
    return Number(identity.PlaceId) !== 0 || Number(identity.GameId) !== 0 ||
        String(identity.Name || '').trim().length > 0;
}

export function placeIdentitiesMatch(left, right) {
    if (!isValidPlaceIdentity(left) || !isValidPlaceIdentity(right)) return false;
    if (Number(left.PlaceId) !== Number(right.PlaceId) || Number(left.GameId) !== Number(right.GameId)) {
        return false;
    }
    if (Number(left.PlaceId) === 0 && Number(left.GameId) === 0) {
        return String(left.Name || '').trim().toLowerCase() === String(right.Name || '').trim().toLowerCase();
    }
    return true;
}
