const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const PAYMENTS_FILE = path.join(
  DIR,
  "Net payments by order - 2026-06-01 - 2026-06-30 (1).csv"
);
const OUTPUT_FILE = path.join(DIR, "qa_country_sales.csv");
const FALLBACK_FILE = path.join(DIR, "qa_country_sales_new.csv");

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
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, j) => (row[h] = values[j] ?? ""));
    return row;
  });
}

function toNumber(value) {
  const n = Number(value);
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

function formatPercent(n) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function formatRangeDate(iso) {
  // 2026-06-01 -> 06/01/2026
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function titleCaseCountry(name) {
  // Keep common multi-word names tidy; data already uses proper names
  return name;
}

/**
 * Sum Net payments by Billing country.
 * (Matches the QA "Product Revenue … / Revenue (ex GST)" country sheet.)
 */
function aggregateByCountry(rows) {
  const byCountry = new Map();
  let minDay = null;
  let maxDay = null;

  for (const row of rows) {
    const day = row["Day"];
    if (day) {
      if (!minDay || day < minDay) minDay = day;
      if (!maxDay || day > maxDay) maxDay = day;
    }

    // Shopify sometimes exports a payment with blank country (and often blank
    // order name). Your QA sheet attributes those to United States.
    const country = (row["Billing country"] || "").trim() || "United States";
    const amount = toNumber(row["Net payments"]);
    byCountry.set(country, (byCountry.get(country) || 0) + amount);
  }

  const entries = [...byCountry.entries()]
    .map(([country, revenue]) => ({
      country: titleCaseCountry(country),
      revenue: round2(revenue),
    }))
    .sort((a, b) => a.country.localeCompare(b.country));

  const total = round2(entries.reduce((s, e) => s + e.revenue, 0));

  return { entries, total, minDay, maxDay };
}

function writeSafely(body) {
  try {
    fs.writeFileSync(OUTPUT_FILE, body, "utf8");
    return OUTPUT_FILE;
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      fs.writeFileSync(FALLBACK_FILE, body, "utf8");
      console.warn(
        `${path.basename(OUTPUT_FILE)} locked — wrote ${path.basename(FALLBACK_FILE)}`
      );
      return FALLBACK_FILE;
    }
    throw err;
  }
}

function main() {
  if (!fs.existsSync(PAYMENTS_FILE)) {
    throw new Error(`Missing ${path.basename(PAYMENTS_FILE)}`);
  }

  console.log(`Reading ${path.basename(PAYMENTS_FILE)}...`);
  const rows = readCsv(PAYMENTS_FILE);
  const { entries, total, minDay, maxDay } = aggregateByCountry(rows);

  if (!minDay || !maxDay) throw new Error("No dated payment rows found");
  console.log(`  ${entries.length} countries, ${rows.length} payment rows`);
  console.log(`  range ${minDay} → ${maxDay}`);

  const rangeLabel = `${formatRangeDate(minDay)} to ${formatRangeDate(maxDay)}`;

  const out = [];
  // Title row
  out.push([rangeLabel, "", "", ""].map(csvCell).join(","));
  out.push(["", "", "", ""].map(csvCell).join(","));
  // Header
  out.push(
    ["Country", "Revenue (ex GST)", "Percentage (ex GST)", ""].map(csvCell).join(",")
  );

  for (const { country, revenue } of entries) {
    const rawPct = total === 0 ? 0 : (revenue / total) * 100;
    // Avoid "-0.00" for tiny negatives like Greece
    const pct = round2(Math.abs(rawPct) < 0.005 ? 0 : rawPct);
    out.push(
      [
        `Product Revenue ${country}`,
        formatMoney(revenue),
        formatPercent(pct),
        "",
      ]
        .map(csvCell)
        .join(",")
    );
  }

  out.push(["", "", "", ""].map(csvCell).join(","));
  out.push(
    ["Total", formatMoney(total), formatPercent(100), ""].map(csvCell).join(",")
  );

  const written = writeSafely(out.join("\n") + "\n");
  console.log(`Wrote ${written}`);
  console.log(`  Total ${formatMoney(total)}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
