#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";

const EASYMAP_URL = "https://easymap.moi.gov.tw/Z10Web/Normal";
const PAGE_TIMEOUT = 30_000;

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function waitForOptions(page: Page, selector: string, minCount: number, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLSelectElement)?.options?.length ?? 0,
      selector
    );
    if (count >= minCount) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timeout waiting for options in ${selector}`);
}

interface LandQueryResult {
  district: string;
  landOffice: string;
  section: string;
  sectionCode: string;
  lotNumber: string;
  area: string;
  currentValue: string;
  announcedPrice: string;
  landRef: string;
  raw: string;
}

async function queryLandParcel(
  city: string,
  town: string,
  section: string,
  lotNumber: string
): Promise<LandQueryResult> {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);

  try {
    await page.goto(EASYMAP_URL, { waitUntil: "networkidle" });

    // Dismiss tutorial dialog if present
    const closeBtn = page.getByRole("button", { name: "我已瞭解" });
    if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBtn.click();
    }

    // Step 1: Select city
    const cityValue = await page.evaluate((cityName: string) => {
      const sel = document.querySelector("#land_city_id") as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => o.text === cityName);
      return opt?.value ?? null;
    }, city);
    if (!cityValue) throw new Error(`City "${city}" not found`);

    await page.selectOption("#land_city_id", cityValue);
    await waitForOptions(page, "#land_town_id", 2);

    // Step 2: Select town
    const townValue = await page.evaluate((townName: string) => {
      const sel = document.querySelector("#land_town_id") as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => o.text === townName);
      return opt?.value ?? null;
    }, town);
    if (!townValue) throw new Error(`Town "${town}" not found in ${city}`);

    await page.selectOption("#land_town_id", townValue);
    await waitForOptions(page, "#land_section_id", 2);

    // Step 3: Select section
    const sectionValue = await page.evaluate((sectionName: string) => {
      const sel = document.querySelector("#land_section_id") as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => o.text === sectionName);
      return opt?.value ?? null;
    }, section);
    if (!sectionValue) throw new Error(`Section "${section}" not found in ${city} ${town}`);

    await page.selectOption("#land_section_id", sectionValue);

    // Step 4: Fill lot number
    await page.fill("#land_landno", lotNumber);

    // Step 5: Click query
    await page.evaluate(() => {
      const links = document.querySelectorAll("a");
      for (const a of links) {
        if (a.textContent?.trim() === "查詢" && a.closest(".tab-pane")) {
          a.click();
          return;
        }
      }
    });

    // Step 6: Wait for result table
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      for (const table of tables) {
        const text = table.innerText;
        if (text.includes("面積") && text.includes("地號")) {
          // Parse the table
          const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
          const data: Record<string, string> = {};
          for (const row of rows) {
            const match = row.match(/^(.+?)\t(.+)$/);
            if (match) {
              data[match[1].trim()] = match[2].trim();
            }
          }
          return {
            district: data["行政區"] ?? "",
            landOffice: data["地政事務所"] ?? "",
            section: data["地段"] ?? "",
            lotNumber: data["地號"] ?? "",
            area: data["面積"] ?? "",
            currentValue: data["公告現值"] ?? "",
            announcedPrice: data["公告地價"] ?? "",
            landRef: data["土地參考資訊"] ?? "",
            raw: text,
          };
        }
      }
      return null;
    });

    if (!result) throw new Error("Query returned no results. The lot number may not exist.");

    return {
      ...result,
      sectionCode: sectionValue,
    };
  } finally {
    await page.close();
  }
}

interface AddressQueryResult {
  address: string;
  district: string;
  landOffice: string;
  section: string;
  lotNumber: string;
  area: string;
  currentValue: string;
  announcedPrice: string;
  landRef: string;
  raw: string;
}

async function queryByAddress(address: string): Promise<AddressQueryResult> {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);

  try {
    await page.goto(EASYMAP_URL, { waitUntil: "load" });

    const closeBtn = page.getByRole("button", { name: "我已瞭解" });
    if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBtn.click();
    }

    // Wait for the doorplate tab and its search handler to be attached.
    await page.waitForSelector("#doorplate-tab", { timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("doorplateSearch") as HTMLElement | null;
        if (!btn) return false;
        // jQuery attaches handler via $(...).on('click') — check event data
        const $ = (window as any).jQuery || (window as any).$;
        if (!$) return true; // fallback: assume ready
        const evs = $._data?.(btn, "events");
        return !!evs?.click?.length;
      },
      undefined,
      { timeout: 15_000 }
    ).catch(() => { /* best-effort */ });

    // Switch to 門牌地址 tab
    await page.evaluate(() => {
      const tab = document.getElementById("doorplate-tab") as HTMLElement | null;
      tab?.click();
    });
    await page.waitForTimeout(300);

    // Fill address via actual keyboard to trigger autocomplete handlers
    await page.click("#roodplateText");
    await page.fill("#roodplateText", address);

    // Click search and wait for the RoadPath_ajax_detail response in parallel.
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("RoadPath_ajax_detail") && r.request().method() === "POST",
        { timeout: 30_000 }
      ),
      page.click("#doorplateSearch"),
    ]);
    if (!resp.ok()) throw new Error(`RoadPath_ajax_detail returned ${resp.status()}`);

    // Now wait for the DOM to render. Result contains both 建物 and 土地 tabs;
    // 土地 tab holds the 地號 data even when hidden.
    await page.waitForFunction(
      () => {
        const c = document.getElementById("roodplateResultsListId");
        return !!c && /地號|地段/.test(c.innerHTML);
      },
      undefined,
      { timeout: 10_000 }
    );

    const result = await page.evaluate(() => {
      const container = document.getElementById("roodplateResultsListId");
      if (!container) return null;
      const raw = container.innerText;

      // The LAND tab table contains 地號/面積
      const tables = container.querySelectorAll("table");
      let data: Record<string, string> = {};
      for (const t of tables) {
        const rows = t.querySelectorAll("tr");
        for (const r of rows) {
          const th = r.querySelector("th");
          const td = r.querySelector("td");
          if (th && td) {
            const key = (th.textContent ?? "").trim();
            const val = (td.textContent ?? "").trim();
            if (key && val && !data[key]) data[key] = val;
          }
        }
      }

      // Extract returned address from the result header
      const addrMatch = raw.match(/查詢結果門牌:\s*\n?\s*(.+)/);
      return {
        address: addrMatch?.[1]?.trim() ?? "",
        district: data["行政區"] ?? "",
        landOffice: data["地政事務所"] ?? "",
        section: data["地段"] ?? "",
        lotNumber: data["地號"] ?? "",
        area: data["面積"] ?? "",
        currentValue: data["公告現值"] ?? "",
        announcedPrice: data["公告地價"] ?? "",
        landRef: data["土地參考資訊"] ?? "",
        raw,
      };
    });

    if (!result || !result.lotNumber) {
      throw new Error("No results for address. Try a different format (e.g. '臺北市內湖區新湖一路36巷50號').");
    }
    return result;
  } finally {
    await page.close();
  }
}

interface SectionItem {
  name: string;
  code: string;
}

async function listSections(city: string, town: string): Promise<SectionItem[]> {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);

  try {
    await page.goto(EASYMAP_URL, { waitUntil: "networkidle" });

    const closeBtn = page.getByRole("button", { name: "我已瞭解" });
    if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBtn.click();
    }

    const cityValue = await page.evaluate((cityName: string) => {
      const sel = document.querySelector("#land_city_id") as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => o.text === cityName);
      return opt?.value ?? null;
    }, city);
    if (!cityValue) throw new Error(`City "${city}" not found`);

    await page.selectOption("#land_city_id", cityValue);
    await waitForOptions(page, "#land_town_id", 2);

    const townValue = await page.evaluate((townName: string) => {
      const sel = document.querySelector("#land_town_id") as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => o.text === townName);
      return opt?.value ?? null;
    }, town);
    if (!townValue) throw new Error(`Town "${town}" not found in ${city}`);

    await page.selectOption("#land_town_id", townValue);
    await waitForOptions(page, "#land_section_id", 2);

    const sections = await page.evaluate(() => {
      const sel = document.querySelector("#land_section_id") as HTMLSelectElement;
      return Array.from(sel.options)
        .filter((o) => o.value !== "")
        .map((o) => ({ name: o.text, code: o.value }));
    });

    return sections;
  } finally {
    await page.close();
  }
}

// ─── MCP Server ───

const server = new McpServer({
  name: "tw-cadastral",
  version: "0.1.0",
});

server.tool(
  "query_land",
  "Query Taiwan land parcel data by lot number. Returns area, announced land value, and other cadastral information from the official easymap system.",
  {
    city: z.string().describe("County/city name, e.g. '桃園市', '臺北市'"),
    town: z.string().describe("Township/district name, e.g. '大園區', '中正區'"),
    section: z.string().describe("Land section name, e.g. '福隆段'"),
    lot_number: z.string().describe("Lot number, e.g. '26', '100-1'"),
  },
  async ({ city, town, section, lot_number }) => {
    try {
      const result = await queryLandParcel(city, town, section, lot_number);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                district: result.district,
                landOffice: result.landOffice,
                section: result.section,
                lotNumber: result.lotNumber,
                area: result.area,
                currentValue: result.currentValue,
                announcedPrice: result.announcedPrice,
                landRef: result.landRef,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_sections",
  "List all land sections (地段) for a given city and township. Useful for finding the correct section name before querying.",
  {
    city: z.string().describe("County/city name, e.g. '桃園市'"),
    town: z.string().describe("Township/district name, e.g. '大園區'"),
  },
  async ({ city, town }) => {
    try {
      const sections = await listSections(city, town);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(sections, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "query_by_address",
  "Query Taiwan land parcel by full address (門牌地址). Returns the matching lot number (地號), section (地段), area, and announced land value. Use this when the user provides an address but not a lot number. Accepts addresses like '臺北市內湖區新湖一路36巷50號'. Do not include 村/里/鄰.",
  {
    address: z.string().describe("Full Taiwan street address, e.g. '臺北市內湖區新湖一路36巷50號'"),
  },
  async ({ address }) => {
    try {
      const result = await queryByAddress(address);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address: result.address,
                district: result.district,
                landOffice: result.landOffice,
                section: result.section,
                lotNumber: result.lotNumber,
                area: result.area,
                currentValue: result.currentValue,
                announcedPrice: result.announcedPrice,
                landRef: result.landRef,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit(0);
});
