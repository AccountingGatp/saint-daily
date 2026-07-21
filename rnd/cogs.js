const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SUPPLIER_FILE = path.join(DIR, "supplier_costs.csv");
const OUTPUT_FILE = path.join(DIR, "cogs.csv");
const FALLBACK_FILE = path.join(DIR, "cogs_new.csv");

const YEAR = 2026;
const GST_DIVISOR = 11; // AU GST-inclusive: GST = amount / 11
/** RBA F11.1 daily exchange rates (official). Column A$1=USD is AUD per USD inverted for USD→AUD. */
const RBA_CSV_URL = "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv";

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      result.push(current);
      current = "";
    } else current += ch;
  }
  result.push(current);
  return result;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = values[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function toNumber(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatMoney(n) {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
}

/** Quote every field so $ and thousands commas survive in the CSV. */
function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/** "06/01" or "2026-06-01" -> { md: "06/01", iso: "2026-06-01" }. */
function parseDate(value) {
  const raw = String(value ?? "").trim().split(/\s+/)[0];

  let m = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) {
    const mm = String(Number(m[2])).padStart(2, "0");
    const dd = String(Number(m[3])).padStart(2, "0");
    return { md: `${mm}/${dd}`, iso: `${m[1]}-${mm}-${dd}` };
  }

  m = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(YEAR);
    const mm = String(Number(m[1])).padStart(2, "0");
    const dd = String(Number(m[2])).padStart(2, "0");
    return { md: `${mm}/${dd}`, iso: `${year}-${mm}-${dd}` };
  }

  return null;
}

/** Sum Product Price + Shipping Cost per date from the supplier sheet. */
function loadDailyTotals(rows) {
  const byDay = new Map();

  for (const row of rows) {
    const parsed =
      parseDate(row["Date"]) || parseDate(row["Day"]) || parseDate(row["Order Time"]);
    if (!parsed) continue;

    const product =
      toNumber(row["Product Price($)"]) ||
      toNumber(row["Product Price ($)"]) ||
      toNumber(row["Product Price"]);
    const shipping =
      toNumber(row["Shipping Cost ($)"]) ||
      toNumber(row["Shipping Cost($)"]) ||
      toNumber(row["Shipping Cost"]);

    if (!byDay.has(parsed.iso)) {
      byDay.set(parsed.iso, { md: parsed.md, product: 0, shipping: 0 });
    }
    const agg = byDay.get(parsed.iso);
    agg.product += product;
    agg.shipping += shipping;
  }

  for (const agg of byDay.values()) {
    agg.product = round2(agg.product);
    agg.shipping = round2(agg.shipping);
  }
  return byDay;
}

/**
 * Fetch USD→AUD rates from RBA F11.1 CSV.
 * RBA publishes A$1=USD (AUD/USD). We store USD→AUD = 1 / AUDUSD for each date.
 */
async function fetchUsdAudRates() {
  console.log("Fetching RBA F11.1 exchange rates...");
  const res = await fetch(RBA_CSV_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`RBA CSV error ${res.status}`);

  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Skip metadata until the Series ID row; data follows.
  let dataStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^Series ID,/i.test(lines[i])) {
      dataStart = i + 1;
      break;
    }
  }
  if (dataStart < 0) throw new Error("RBA CSV: Series ID row not found");

  const MONTHS = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };

  const rates = new Map();
  for (let i = dataStart; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const dateLabel = (cols[0] || "").trim(); // e.g. 01-Jun-2026
    const audUsd = Number(cols[1]); // A$1=USD
    if (!dateLabel || !Number.isFinite(audUsd) || audUsd === 0) continue;

    const m = dateLabel.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (!m) continue;
    const mm = MONTHS[m[2]];
    if (!mm) continue;

    const iso = `${m[3]}-${mm}-${String(Number(m[1])).padStart(2, "0")}`;
    // Convert USD costs → AUD: multiply by 1 / (AUD per USD)
    rates.set(iso, Math.round((1 / audUsd) * 10000) / 10000);
  }

  if (rates.size === 0) throw new Error("RBA CSV: no AUD/USD rates parsed");
  return rates;
}

/** Same-day RBA rate, else nearest prior business day (weekends/holidays). */
function resolveRate(isoDate, rateByDate) {
  if (rateByDate.has(isoDate)) return rateByDate.get(isoDate);
  const d = new Date(`${isoDate}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const key = d.toISOString().slice(0, 10);
    if (rateByDate.has(key)) return rateByDate.get(key);
  }
  throw new Error(`No RBA USD→AUD rate for ${isoDate}`);
}

function writeCsvSafely(filePath, body) {
  try {
    fs.writeFileSync(filePath, body, "utf8");
    return filePath;
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      fs.writeFileSync(FALLBACK_FILE, body, "utf8");
      console.warn(
        `${path.basename(filePath)} is locked (open in Excel?) - wrote ${path.basename(
          FALLBACK_FILE
        )} instead`
      );
      return FALLBACK_FILE;
    }
    throw err;
  }
}

async function main() {
  if (!fs.existsSync(SUPPLIER_FILE)) {
    throw new Error(
      `Missing ${path.basename(SUPPLIER_FILE)} - needs columns: Date, Product Price($), Shipping Cost ($)`
    );
  }

  console.log(`Reading ${path.basename(SUPPLIER_FILE)}...`);
  const rows = readCsv(SUPPLIER_FILE);
  const byDay = loadDailyTotals(rows);
  const dates = [...byDay.keys()].sort();
  if (dates.length === 0) throw new Error("No dated rows found in supplier_costs.csv");
  console.log(`  ${dates.length} days (${dates[0]} -> ${dates[dates.length - 1]})`);

  const rateByDate = await fetchUsdAudRates();
  console.log(`  ${rateByDate.size} RBA rate days loaded`);

  const headers = [
    "Date",
    "Product Price($)",
    "Shipping Cost ($)",
    "Total(Product & Shipping cost)",
    "Convert It in AUD",
    "GST",
    "COGS",
    "Column 1",
  ];

  const outLines = [headers.map(csvCell).join(",")];

  const totals = { product: 0, shipping: 0, total: 0, aud: 0, gst: 0, cogs: 0 };

  for (const iso of dates) {
    const { md, product, shipping } = byDay.get(iso);
    const total = round2(product + shipping);
    const rate = resolveRate(iso, rateByDate);
    const aud = round2(total * rate);
    const gst = round2(aud / GST_DIVISOR);
    const cogs = round2(aud - gst);

    totals.product += product;
    totals.shipping += shipping;
    totals.total += total;
    totals.aud += aud;
    totals.gst += gst;
    totals.cogs += cogs;

    outLines.push(
      [
        md,
        formatMoney(product),
        formatMoney(shipping),
        formatMoney(total),
        formatMoney(aud),
        formatMoney(gst),
        formatMoney(cogs),
        formatMoney(aud),
      ]
        .map(csvCell)
        .join(",")
    );
  }

  // Blank spacer rows then a computed Total row (matches your layout).
  outLines.push("");
  outLines.push(
    [
      "Total",
      formatMoney(round2(totals.product)),
      formatMoney(round2(totals.shipping)),
      formatMoney(round2(totals.total)),
      formatMoney(round2(totals.aud)),
      formatMoney(round2(totals.gst)),
      formatMoney(round2(totals.cogs)),
      formatMoney(round2(totals.aud)),
    ]
      .map(csvCell)
      .join(",")
  );

  const body = outLines.join("\n") + "\n";
  const written = writeCsvSafely(OUTPUT_FILE, body);
  console.log(`Wrote ${written} (${dates.length} days + Total row)`);

  if (written === OUTPUT_FILE) {
    try {
      fs.writeFileSync(FALLBACK_FILE, body, "utf8");
    } catch {
      /* fallback copy is best-effort */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
