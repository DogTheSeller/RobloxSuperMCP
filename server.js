import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { SUPER_TOOLS, TOOL_HANDLERS } from './tool_registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Spawn official Roblox StudioMCP.exe Subprocess safely
function getOfficialStudioMCPPath() {
    const robloxBase = 'C:\\Users\\win\\AppData\\Local\\Roblox\\Versions';
    if (fs.existsSync(robloxBase)) {
        const candidates = fs.readdirSync(robloxBase)
            .map(version => path.join(robloxBase, version, 'StudioMCP.exe'))
            .filter(candidate => fs.existsSync(candidate))
            .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
        if (candidates.length > 0) return candidates[0];
    }
    return path.join(__dirname, 'StudioMCP.exe');
}

const studioProcessPath = getOfficialStudioMCPPath();
let studioProc = null;
let studioFailure = null;
let nextStudioRequestId = 1;
let studioReadyPromise = Promise.resolve();
let studioLines = null;
const pendingStudioRequests = new Map();
const activeIdempotentCalls = new Map();

function requestHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

try {
    studioProc = spawn(studioProcessPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    studioProc.on('error', (err) => {
        studioFailure = err.message;
        failPendingStudioRequests(`Studio MCP process error: ${err.message}`);
    });
    studioProc.on('exit', (code, signal) => {
        studioFailure = `Studio MCP exited (${signal || code || 'unknown'}).`;
        failPendingStudioRequests(studioFailure);
    });

    studioLines = readline.createInterface({ input: studioProc.stdout, terminal: false });
    studioLines.on('line', line => {
        if (!line.trim()) return;
        try {
            const response = JSON.parse(line);
            const pending = pendingStudioRequests.get(response.id);
            if (!pending) return;
            pendingStudioRequests.delete(response.id);
            clearTimeout(pending.timeout);
            studioFailure = null;
            pending.resolve({ ...response, id: pending.originalId });
        } catch (error) {
            studioFailure = `Invalid Studio MCP response: ${error.message}`;
        }
    });

    studioReadyPromise = initializeStudioMCP();
} catch (e) {
    studioFailure = e instanceof Error ? e.message : String(e);
}

async function initializeStudioMCP() {
    const response = await queryStudioMCP({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'RobloxSuperMCP', version: '3.0.1' }
        }
    }, 8000);
    if (response && !response.error && studioProc?.stdin.writable) {
        studioProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
}

function queryStudioMCP(request, timeoutMs = 5000) {
    return new Promise(resolve => {
        if (!studioProc || !studioProc.stdin.writable) {
            resolve(null);
            return;
        }

        if (request.id === undefined) {
            studioProc.stdin.write(JSON.stringify(request) + '\n');
            resolve(null);
            return;
        }

        const internalId = nextStudioRequestId++;
        const timeout = setTimeout(() => {
            pendingStudioRequests.delete(internalId);
            studioFailure = `Studio MCP timed out handling '${request.method}'.`;
            resolve(null);
        }, timeoutMs);
        pendingStudioRequests.set(internalId, {
            originalId: request.id,
            resolve,
            timeout
        });
        studioProc.stdin.write(JSON.stringify({ ...request, id: internalId }) + '\n');
    });
}

function failPendingStudioRequests(message) {
    for (const pending of pendingStudioRequests.values()) {
        clearTimeout(pending.timeout);
        pending.resolve(null);
    }
    pendingStudioRequests.clear();
    studioFailure = message;
}

// 3. Stdio Communication with AI Client
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    if (!line.trim()) return;

    let request;
    try {
        request = JSON.parse(line);
    } catch (error) {
        sendResponse({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${error.message}` }
        });
        return;
    }

    try {
        if (request.method === 'initialize') {
            sendResponse({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'roblox-super-mcp', version: '3.0.1' }
                }
            });
            return;
        }

        if (request.id === undefined) {
            if (request.method !== 'notifications/initialized') {
                await queryStudioMCP(request);
            }
            return;
        }

        // A. Handle tools/list request
        if (request.method === 'tools/list') {
            let studioTools = [];
            await studioReadyPromise;
            const studioResponse = await queryStudioMCP(request);
            if (studioResponse && studioResponse.result && studioResponse.result.tools) {
                studioTools = studioResponse.result.tools;
            }

            // Merge Studio Tools + Super Tools
            const customNames = new Set(SUPER_TOOLS.map(tool => tool.name));
            const mergedTools = [...SUPER_TOOLS, ...studioTools.filter(tool => !customNames.has(tool.name))];
            sendResponse({
                jsonrpc: "2.0",
                id: request.id,
                result: { tools: mergedTools }
            });
            return;
        }

        // B. Handle tools/call request
        if (request.method === 'tools/call') {
            const toolName = request.params ? request.params.name : null;

            if (toolName && TOOL_HANDLERS[toolName]) {
                const handler = TOOL_HANDLERS[toolName];
                const toolArguments = request.params.arguments || {};
                const communicator = {
                    isAlive: () => Boolean(studioProc?.stdin.writable),
                    callTool: async (name, args, timeoutMs = 20_000) => {
                        await studioReadyPromise;
                        return queryStudioMCP({
                            jsonrpc: "2.0",
                            id: 1,
                            method: "tools/call",
                            params: { name, arguments: args }
                        }, timeoutMs);
                    }
                };
                const idempotencyKey = ['apply_script_patch', 'create_architecture'].includes(toolName) &&
                    typeof toolArguments.idempotency_key === 'string' &&
                    toolArguments.idempotency_key
                    ? `${toolName}:${toolArguments.idempotency_key}`
                    : null;
                let resultPromise;
                if (idempotencyKey && activeIdempotentCalls.has(idempotencyKey)) {
                    const active = activeIdempotentCalls.get(idempotencyKey);
                    if (active.RequestHash !== requestHash(toolArguments)) {
                        resultPromise = Promise.resolve(JSON.stringify({
                            Status: 'Idempotency Conflict',
                            error: 'An in-flight call is already using this idempotency_key with different arguments.'
                        }));
                    } else {
                        resultPromise = active.Promise;
                    }
                } else {
                    resultPromise = (async () => {
                        try {
                            return await handler(toolArguments, communicator);
                        } finally {
                            if (idempotencyKey) activeIdempotentCalls.delete(idempotencyKey);
                        }
                    })();
                    if (idempotencyKey) {
                        activeIdempotentCalls.set(idempotencyKey, {
                            RequestHash: requestHash(toolArguments),
                            Promise: resultPromise
                        });
                    }
                }
                const resultOutput = await resultPromise;

                sendResponse({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        content: [
                            { type: "text", text: typeof resultOutput === 'string' ? resultOutput : JSON.stringify(resultOutput, null, 2) }
                        ]
                    }
                });
                return;
            }

            // Forward non-custom tool calls to StudioMCP
            await studioReadyPromise;
            const studioResponse = await queryStudioMCP(request);
            if (studioResponse) {
                sendResponse(studioResponse);
            } else {
                sendResponse({
                    jsonrpc: "2.0",
                    id: request.id,
                    error: {
                        code: -32601,
                        message: `Tool '${toolName}' execution timeout or target unavailable.`,
                        data: studioFailure ? { StudioMCP: studioFailure } : undefined
                    }
                });
            }
            return;
        }

        // C. Pass through other MCP standard methods
        await studioReadyPromise;
        const studioResponse = await queryStudioMCP(request);
        if (studioResponse) {
            sendResponse(studioResponse);
        } else {
            sendResponse({
                jsonrpc: "2.0",
                id: request.id,
                result: {}
            });
        }

    } catch (error) {
        sendResponse({
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32603, message: `Internal error: ${error.message}` }
        });
    }
});

function sendResponse(resp) {
    if (process.stdout.writable) process.stdout.write(JSON.stringify(resp) + '\n');
}

let shuttingDown = false;
function shutdownServer(reason = 'Server shutting down.') {
    if (shuttingDown) return;
    shuttingDown = true;
    failPendingStudioRequests(reason);
    studioLines?.close();
    if (!rl.closed) rl.close();
    if (studioProc && !studioProc.killed) {
        studioProc.stdin?.end();
        studioProc.kill();
    }
}

rl.on('close', () => shutdownServer('Client input closed.'));
process.once('SIGINT', () => shutdownServer('Received SIGINT.'));
process.once('SIGTERM', () => shutdownServer('Received SIGTERM.'));
