import {
    LUAU_SOURCE_FINGERPRINT,
    clampInteger,
    executeLuau,
    luaJson
} from './studio_utils.js';

const ROOTS = [
    'ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'StarterGui',
    'ServerStorage', 'Workspace', 'StarterPack'
];
const MODES = new Set(['literal', 'pattern', 'symbol', 'method']);

export async function run(args = {}, studioCommunicator) {
    const query = String(args.query || '').trim();
    if (!query) return JSON.stringify({ error: 'Provide a non-empty source search query.' });

    const mode = args.regex === true ? 'pattern' : String(args.mode || 'literal').toLowerCase();
    if (!MODES.has(mode)) return JSON.stringify({ error: `Unsupported mode '${mode}'.` });
    const roots = Array.isArray(args.roots)
        ? args.roots.map(String).filter(root => ROOTS.includes(root))
        : ROOTS;
    if (roots.length === 0) return JSON.stringify({ error: 'No supported roots were selected.' });

    const request = {
        query,
        mode,
        caseSensitive: mode === 'pattern' ? true : args.case_sensitive === true,
        roots,
        offset: clampInteger(args.offset, 0, 0, 100_000),
        limit: clampInteger(args.limit, 100, 1, 300),
        contextLines: clampInteger(args.context_lines, 1, 0, 5),
        pathContains: String(args.path_contains || '').toLowerCase(),
        classNames: Array.isArray(args.class_names) ? args.class_names.map(String) : []
    };

    const code = `
local HttpService = game:GetService("HttpService")
${LUAU_SOURCE_FINGERPRINT}
local request = HttpService:JSONDecode(${luaJson(request)})
local output = {}
local totalMatches = 0
local scannedScripts = 0
local patternError = nil

local function escapePattern(value)
    return string.gsub(value, "([^%w])", "%%%1")
end

local needle = request.query
local plain = request.mode == "literal" or request.mode == "method"
if request.mode == "symbol" then
    needle = "%f[%w_]" .. escapePattern(needle) .. "%f[^%w_]"
    plain = false
elseif request.mode == "method" and not string.find(needle, ":", 1, true) and not string.find(needle, ".", 1, true) then
    needle = ":" .. needle
end
if not request.caseSensitive then
    needle = string.lower(needle)
end

local function classAllowed(instance)
    if #request.classNames == 0 then return true end
    for _, className in request.classNames do
        if instance.ClassName == className then return true end
    end
    return false
end

local function lineAt(source, position)
    local _, count = string.gsub(string.sub(source, 1, position - 1), "\\n", "")
    return count + 1
end

local function snippetAt(lines, lineNumber)
    local first = math.max(1, lineNumber - request.contextLines)
    local last = math.min(#lines, lineNumber + request.contextLines)
    local parts = {}
    local truncated = false
    for index = first, last do
        local line = lines[index]
        if #line > 500 then
            line = string.sub(line, 1, 500)
            truncated = true
        end
        table.insert(parts, tostring(index) .. ": " .. line)
    end
    return table.concat(parts, "\\n"), truncated
end

for _, rootName in request.roots do
    local root = game:GetService(rootName)
    for _, instance in root:GetDescendants() do
        if not instance:IsA("LuaSourceContainer") or not classAllowed(instance) then continue end
        local path = instance:GetFullName()
        if request.pathContains ~= "" and not string.find(string.lower(path), request.pathContains, 1, true) then continue end
        local ok, source = pcall(function() return instance.Source end)
        if not ok then continue end
        scannedScripts += 1
        local haystack = request.caseSensitive and source or string.lower(source)
        local lines = string.split(source, "\\n")
        local cursor = 1
        while cursor <= #haystack + 1 do
            local findOk, first, last = pcall(string.find, haystack, needle, cursor, plain)
            if not findOk then
                patternError = tostring(first)
                break
            end
            if not first then break end
            totalMatches += 1
            if totalMatches > request.offset and #output < request.limit then
                local line = lineAt(source, first)
                local snippet, snippetTruncated = snippetAt(lines, line)
                table.insert(output, {
                    Path = path,
                    Name = instance.Name,
                    ClassName = instance.ClassName,
                    Line = line,
                    Column = string.find(string.reverse(string.sub(source, 1, first - 1)), "\\n", 1, true) or first,
                    Match = string.sub(source, first, math.min(last, first + 200)),
                    Snippet = snippet,
                    SnippetTruncated = snippetTruncated,
                    SourceHash = sourceFingerprint(source),
                })
            end
            cursor = math.max(last + 1, first + 1)
            if #output >= request.limit and totalMatches >= request.offset + request.limit then
                -- Continue counting only within this source is expensive and does not improve the next cursor.
                break
            end
        end
        if patternError then break end
    end
    if patternError then break end
end
return HttpService:JSONEncode({
    Matches = output,
    Returned = #output,
    ObservedMatches = totalMatches,
    ScannedScripts = scannedScripts,
    NextOffset = #output == request.limit and request.offset + #output or nil,
    PatternError = patternError,
})
`;
    const result = await executeLuau(studioCommunicator, code, {
        label: 'Live source search',
        timeoutMs: 30_000
    });
    if (result.PatternError) {
        return JSON.stringify({ error: `Invalid Luau pattern: ${result.PatternError}`, Mode: mode }, null, 2);
    }
    return JSON.stringify({
        Query: query,
        Mode: mode,
        ...result,
        Evidence: 'live-source',
        Caveat: mode === 'pattern'
            ? 'Pattern mode uses case-sensitive Luau string patterns, not PCRE regular expressions.'
            : undefined
    }, null, 2);
}
