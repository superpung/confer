# confer MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) stdio server that exposes the **confer** paper corpus to AI agents (Claude Desktop, Cursor, Cline, etc.).

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

## Build

```bash
cd mcp
npm install
npm run build
# → dist/server.js
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `CONFER_DATA_DIR` | `../web/public/data` | Absolute or relative path to the directory containing `venues.json` and per-venue JSON files. |

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "confer": {
      "command": "node",
      "args": ["/absolute/path/to/confcrawl/mcp/dist/server.js"],
      "env": {
        "CONFER_DATA_DIR": "/absolute/path/to/confcrawl/web/public/data"
      }
    }
  }
}
```

## Cursor / VS Code (Cline)

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
