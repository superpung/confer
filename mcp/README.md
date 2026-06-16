# confer MCP Server

[![npm version](https://img.shields.io/npm/v/confer-mcp?logo=npm&label=confer-mcp)](https://www.npmjs.com/package/confer-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) stdio server that exposes the **confer** paper corpus to AI agents — Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex, and any other MCP-capable client.

## Tools

| Tool | Description |
|------|-------------|
| `list_venues` | List all conferences/journals, optionally filter by `category` or `series`. |
| `search_papers` | Field-aware full-text search (`author:`, `title:`, `inst:`, `track:`, `venue:`, `year:`, `keyword:`, `doi:`; `-` prefix excludes). |
| `get_paper` | Retrieve the full record for a paper by `venue` + `id`. |
| `find_similar` | TF-IDF cosine-similarity neighbours across the full corpus. |
| `top_authors` | Most prolific authors (optionally filtered by venue or query). |
| `top_institutions` | Most represented institutions. |
| `top_tracks` | Most common tracks/topics. |
| `export_bibtex` | BibTeX export for a list of `{venue, id}` references. |

## Quick start (no clone, no build)

The server is published on npm as **`confer-mcp`**. Most clients use the same
block below — `npx` fetches and runs the server, which streams the corpus from
`https://confer.repus.me/data` on demand (no local data needed):

```json
{
  "mcpServers": {
    "confer": {
      "command": "npx",
      "args": ["-y", "confer-mcp"]
    }
  }
}
```

Requires **Node ≥ 18** on your PATH. Restart the client after editing its config.

> The first query fetches data and may take a few seconds; later queries are fast.

## Set it up in your client

### Claude Desktop

Edit the config file, add the `mcpServers` block above, and restart Claude Desktop.

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

### Claude Code (CLI)

One command — no file editing:

```bash
claude mcp add confer -- npx -y confer-mcp
# user-wide instead of project-local:
claude mcp add confer -s user -- npx -y confer-mcp
```

### Cursor

Add the `mcpServers` block to `~/.cursor/mcp.json` (global) or
`.cursor/mcp.json` (per-project), or use **Settings → MCP → Add new server**.

### VS Code (GitHub Copilot)

VS Code uses the key `servers` (not `mcpServers`). Add to `.vscode/mcp.json`
(workspace) or your user `mcp.json`, then enable it from the Copilot chat
**Tools** picker — or run **MCP: Add Server** from the Command Palette.

```json
{
  "servers": {
    "confer": {
      "command": "npx",
      "args": ["-y", "confer-mcp"]
    }
  }
}
```

### Cline / Windsurf / other VS Code agents

Use the standard `mcpServers` block above — Cline in its
`cline_mcp_settings.json`, Windsurf in `~/.codeium/windsurf/mcp_config.json`
(or each tool's "Add MCP server" UI).

### Codex CLI (OpenAI)

Codex uses **TOML** at `~/.codex/config.toml`:

```toml
[mcp_servers.confer]
command = "npx"
args = ["-y", "confer-mcp"]
```

Or add it from the CLI:

```bash
codex mcp add confer -- npx -y confer-mcp
```

### ChatGPT (remote connectors only)

ChatGPT's Developer Mode connectors accept **a public HTTPS MCP URL** — they
can't launch a local `npx` command. To use confer in ChatGPT you must expose
this stdio server over HTTP and make it publicly reachable, e.g. bridge it with
a stdio→HTTP gateway and a tunnel:

```bash
# 1. bridge the stdio server to a local HTTP/SSE endpoint
npx -y supergateway --stdio "npx -y confer-mcp"
# 2. expose that port publicly (separate terminal)
ngrok http <port-printed-by-supergateway>
```

Then in ChatGPT: **Settings → Connectors → Advanced → Developer mode → Add
custom connector**, and paste the public `https://….ngrok.app/mcp` URL. See the
[supergateway](https://github.com/supercorp-ai/supergateway) and
[ChatGPT connector](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
docs for exact flags. (This keeps a process + tunnel running on your machine.)

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `CONFER_DATA_URL` | `https://confer.repus.me/data` | Base URL the server fetches `venues.json` and per-venue JSON from. |
| `CONFER_DATA_DIR` | *(auto)* | Read from a local directory instead of the network. Auto-detected when run from a repo checkout (`web/public/data`); set it to force a path and run fully offline. |
| `HTTPS_PROXY` / `HTTP_PROXY` | — | Used for the remote fetch when set (e.g. behind a corporate proxy). |

## Run from a local checkout (offline / development)

```bash
cd mcp
npm install
npm run build      # → dist/server.js
```

Then point your client at the built file (it auto-uses the repo's
`web/public/data`, so it works offline):

```json
{
  "mcpServers": {
    "confer": {
      "command": "node",
      "args": ["/absolute/path/to/confcrawl/mcp/dist/server.js"]
    }
  }
}
```

## Example queries

```
list_venues(series="ICSE")
search_papers(query="author:lecun deep learning", venues=["icml2025","iclr2026"], limit=10)
get_paper(venue="icse2025", id="<paper-id>")
find_similar(venue="icse2025", id="<paper-id>", n=10)
top_authors(venues=["fse2025","fse2026"], limit=15)
top_institutions(query="venue:ICSE year:2025")
export_bibtex(refs=[{"venue":"icse2025","id":"<id>"},{"venue":"fse2025","id":"<id>"}])
```

## Query syntax

| Prefix | Matches |
|--------|---------|
| `author:smith` | Author name contains "smith" |
| `title:"code review"` | Title contains the phrase |
| `inst:mit` | Author institution contains "mit" |
| `track:testing` | Track name contains "testing" |
| `venue:ICSE` | Venue name or id contains "ICSE" |
| `year:2025` | Venue year is 2025 |
| `keyword:fuzzing` | Paper keyword contains "fuzzing" |
| `-author:doe` | Exclude papers where author contains "doe" |
| *(bare word)* | Matches anywhere in title, abstract, authors, tracks, etc. |

Multiple terms are combined with AND semantics.
