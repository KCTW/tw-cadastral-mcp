# tw-cadastral-mcp

MCP server for querying Taiwan cadastral (land registry) data.

Automates [easymap.land.moi.gov.tw](https://easymap.land.moi.gov.tw/) — the official cadastral map system by Taiwan's Ministry of the Interior — via Playwright, and exposes the results as MCP tools.

## What it does

Given a lot number (地段地號), returns:

- **Land area** (面積, m²)
- **Announced current value** (公告現值, TWD/m²)
- **Announced land price** (公告地價, TWD/m²)
- **Land office** (地政事務所)
- **Administrative district** (行政區)

## Tools

### `query_land`

Query a specific land parcel.

| Parameter | Description | Example |
|-----------|-------------|---------|
| `city` | County/city | `桃園市` |
| `town` | Township/district | `大園區` |
| `section` | Land section name | `福隆段` |
| `lot_number` | Lot number | `26` |

Example response:

```json
{
  "district": "桃園市 大園區",
  "landOffice": "蘆竹地政事務所",
  "section": "0898 福隆段",
  "lotNumber": "00260000",
  "area": "5621.99 平方公尺",
  "currentValue": "54600 元/平方公尺",
  "announcedPrice": "11200 元/平方公尺"
}
```

### `list_sections`

List all land sections for a city/township. Useful when you don't know the exact section name.

| Parameter | Description | Example |
|-----------|-------------|---------|
| `city` | County/city | `桃園市` |
| `town` | Township/district | `大園區` |

## Setup

### Prerequisites

- Node.js 18+
- Playwright browsers: `npx playwright install chromium`

### Install

```bash
npm install
npm run build
```

### Configure in Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "tw-cadastral": {
      "command": "node",
      "args": ["/path/to/tw-cadastral-mcp/dist/index.js"]
    }
  }
}
```

Or use `tsx` for development:

```json
{
  "mcpServers": {
    "tw-cadastral": {
      "command": "npx",
      "args": ["tsx", "/path/to/tw-cadastral-mcp/src/index.ts"]
    }
  }
}
```

## Data source

All data comes from [地籍圖資網路便民服務系統](https://easymap.land.moi.gov.tw/) operated by the Ministry of the Interior (內政部地政司). This tool automates the public web interface — no API key or authentication required.

> **Disclaimer**: The cadastral data provided by this system is periodically replicated from county/city land databases and is for reference only. For official records, please obtain certified copies (謄本) from your local land office.

## License

MIT
