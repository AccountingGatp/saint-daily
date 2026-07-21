const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SALES_FILE = path.join(
  DIR,
  "Total sales by order - 2026-06-01 - 2026-06-30.csv"
);
const PAYMENTS_FILE = path.join(
  DIR,
  "Net payments by order - 2026-06-01 - 2026-06-30 (1).csv"
);
const OUTPUT_FILE = path.join(DIR, "combined.csv");

/** Parse a CSV line respecting double-quoted fields. */
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
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function escapeCsv(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Aggregate net-payment rows by Order name.
 * Sums money fields; keeps first gateway/card/country when only one,
 * otherwise joins unique values with " | ".
 */
function aggregatePayments(paymentRows) {
  const byOrder = new Map();

  for (const row of paymentRows) {
    const orderName = row["Order name"];
    if (!orderName) continue;

    let agg = byOrder.get(orderName);
    if (!agg) {
      agg = {
        "Payment Day": row["Day"] || "",
        "Transaction ID": row["Transaction ID"] || "",
        "Payment gateway": row["Payment gateway"] || "",
        "Credit card type": row["Credit card type"] || "",
        "Credit card tier": row["Credit card tier"] || "",
        "Billing country": row["Billing country"] || "",
        "Gift card ID": row["Gift card ID"] || "",
        "Gross payments": 0,
        "Refunded payments": 0,
        "Net payments": 0,
        _gateways: new Set(),
        _cardTypes: new Set(),
        _cardTiers: new Set(),
        _countries: new Set(),
        _txIds: new Set(),
        _days: new Set(),
      };
      byOrder.set(orderName, agg);
    }

    if (row["Day"]) agg._days.add(row["Day"]);
    if (row["Transaction ID"]) agg._txIds.add(row["Transaction ID"]);
    if (row["Payment gateway"]) agg._gateways.add(row["Payment gateway"]);
    if (row["Credit card type"]) agg._cardTypes.add(row["Credit card type"]);
    if (row["Credit card tier"]) agg._cardTiers.add(row["Credit card tier"]);
    if (row["Billing country"]) agg._countries.add(row["Billing country"]);

    agg["Gross payments"] += toNumber(row["Gross payments"]);
    agg["Refunded payments"] += toNumber(row["Refunded payments"]);
    agg["Net payments"] += toNumber(row["Net payments"]);
  }

  for (const agg of byOrder.values()) {
    agg["Payment Day"] = [...agg._days].join(" | ");
    agg["Transaction ID"] = [...agg._txIds].join(" | ");
    agg["Payment gateway"] = [...agg._gateways].join(" | ");
    agg["Credit card type"] = [...agg._cardTypes].join(" | ");
    agg["Credit card tier"] = [...agg._cardTiers].join(" | ");
    agg["Billing country"] = [...agg._countries].join(" | ");
    delete agg._days;
    delete agg._txIds;
    delete agg._gateways;
    delete agg._cardTypes;
    delete agg._cardTiers;
    delete agg._countries;
  }

  return byOrder;
}

const PAYMENT_COLUMNS = [
  "Payment Day",
  "Transaction ID",
  "Payment gateway",
  "Credit card type",
  "Credit card tier",
  "Billing country",
  "Gift card ID",
  "Gross payments",
  "Refunded payments",
  "Net payments",
];

function main() {
  console.log("Reading total sales...");
  const sales = readCsv(SALES_FILE);
  console.log(`  ${sales.rows.length} sales rows`);

  console.log("Reading net payments...");
  const payments = readCsv(PAYMENTS_FILE);
  console.log(`  ${payments.rows.length} payment rows`);

  const paymentsByOrder = aggregatePayments(payments.rows);
  console.log(`  ${paymentsByOrder.size} unique orders in payments`);

  const outHeaders = [...sales.headers, ...PAYMENT_COLUMNS];
  const outLines = [outHeaders.map(escapeCsv).join(",")];

  let matched = 0;
  let unmatched = 0;

  for (const sale of sales.rows) {
    const orderName = sale["Order name"];
    const pay = paymentsByOrder.get(orderName);
    if (pay) matched++;
    else unmatched++;

    const values = sales.headers.map((h) => sale[h] ?? "");
    for (const col of PAYMENT_COLUMNS) {
      values.push(pay ? pay[col] ?? "" : "");
    }
    outLines.push(values.map(escapeCsv).join(","));
  }

  fs.writeFileSync(OUTPUT_FILE, outLines.join("\n") + "\n", "utf8");

  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`  matched sales rows:   ${matched}`);
  console.log(`  unmatched sales rows: ${unmatched}`);
}

main();
