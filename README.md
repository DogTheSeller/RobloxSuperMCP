# Roblox Super MCP

Roblox Super MCP is a Node.js MCP server that connects an MCP client to the
official Roblox Studio MCP process. It adds evidence-driven discovery, live
audits, atomic script edits, verification, and rollback-oriented tools.

## Requirements

- Windows
- Roblox Studio with the official `StudioMCP.exe`
- Node.js 18 or newer
- An MCP client that supports a JSON MCP server configuration

## Install and test

Open PowerShell in this folder:

```powershell
cd H:\TestingNEWMCP
npm install
npm test
node server.js
```

Stop `node server.js` with `Ctrl+C` after confirming it starts successfully.

## Replace the old MCP launcher

1. Find the existing `mcp.bat` or MCP launcher used by your MCP client.
2. Make a backup before changing it, for example:

   ```powershell
   Copy-Item .\mcp.bat .\mcp.bat.backup
   ```

3. Replace its contents with the following, updating the path if this project
   is stored somewhere else:

   ```bat
   @echo off
   cd /d H:\TestingNEWMCP
   node server.js
   ```

4. Restart the MCP client and Roblox Studio connection.

The launcher must keep the server attached to standard input and output. Do
not add logging or other text to stdout because it can corrupt MCP messages.

## Configure an MCP client directly

Instead of using a batch file, add the contents of `mcp-config.json` to your
client configuration:

```json
{
  "mcpServers": {
    "roblox-super-mcp": {
      "command": "node",
      "args": ["H:/TestingNEWMCP/server.js"]
    }
  }
}
```

Use forward slashes in JSON paths, or escape Windows backslashes as `\\`.

## How it works

`server.js` starts the latest Roblox `StudioMCP.exe` found under:

```text
C:\Users\win\AppData\Local\Roblox\Versions
```

It then exposes the tools registered in `tool_registry.js`. The `tools`
directory contains the discovery, inspection, auditing, editing, verification,
and rollback helpers.

## Updating

Pull the latest version, then restart the MCP client:

```powershell
git pull
npm test
```

Keep the original launcher backup until the new MCP has been tested in Roblox
Studio.
