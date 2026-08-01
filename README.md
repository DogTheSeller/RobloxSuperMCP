# Roblox Super MCP

Roblox Super MCP is a Node.js MCP server that connects an MCP client to the
official Roblox Studio MCP process. It adds discovery, inspection, auditing,
atomic script edits, verification, and rollback-oriented tools.

## Requirements

- Windows
- Roblox Studio with the official `StudioMCP.exe`
- Node.js 18 or newer
- An MCP-compatible client

## Install and test

From the project directory, run:

```powershell
npm install
npm test
node server.js
```

The server communicates over standard input and output. Stop the manual test
with `Ctrl+C` after confirming it starts successfully.

## Replace an existing MCP launcher

If your current setup starts the original MCP through an `mcp.bat` file:

1. Back up the existing launcher.
2. Replace its contents with:

   ```bat
   @echo off
   cd /d "<path-to-this-project>"
   node server.js
   ```

   Replace `<path-to-this-project>` with the folder where you cloned this
   repository. Keep the quotes if the path contains spaces.

3. Restart the MCP client and Roblox Studio connection.

Do not print diagnostic messages to standard output. MCP messages use that
stream; diagnostics should go to standard error or a log file.

## Configure an MCP client directly

You can configure the client without a batch file. Add this server entry and
replace the example path with the location of your local clone:

```json
{
  "mcpServers": {
    "roblox-super-mcp": {
      "command": "node",
      "args": ["<path-to-this-project>/server.js"]
    }
  }
}
```

Use forward slashes in JSON paths, or escape Windows backslashes as `\\`.

## How it works

When started, the server locates the newest Roblox `StudioMCP.exe` in the
current Windows user's Roblox installation, starts it, and forwards validated
MCP requests to it. The available tool definitions are registered in
`tool_registry.js`; implementation helpers live in the `tools` directory.

## Updating

Pull the latest version, test it, and restart the MCP client:

```powershell
git pull
npm install
npm test
```

Keep a backup of the previous launcher until the replacement has been tested
in Roblox Studio.
