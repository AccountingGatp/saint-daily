const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const PAYMENTS_FILE = path.join(
  DIR,
  "Net payments by order - 2026-06-01 - 2026-06-30 (1).csv"
);
const INPUTS_FILE = path.join(DIR, "fees_inputs.csv");
const OUTPUT_FILE = path.join(DIR, "fees.csv");
const FALLBACK_FILE = path.join(DIR, "fees_new.csv");

/** Output gateway order (matches sample sheet). */
const GATEWAY_ORDER = ["Afterpay", "Paypal", "Shopify"];

/** Gateways that charge GST on merchant fees. */
const GST_ON_FEE_GATEWAYS = new Set(["Afterpay", "Shopify"]);

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (x) => {
  if (x === "" || x == null) return null;
  const n = parseFloat(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

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

function isoDay(d) {
  d = String(d || "").trim();
  let m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  return d;
}

/** Sample sheet dates look like 6/1/2026. */
function formatSheetDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

function formatMoney(n) {
  if (n == null) return "";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatRate(n) {
  if (n == null || !Number.isFinite(n)) return "";
  return `${n.toFixed(1)}%`;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
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

function normalizeGateway(raw) {
  const g = String(raw || "").trim().toLowerCase();
  if (g.includes("afterpay") || g.includes("clearpay")) return "Afterpay";
  if (g.includes("paypal")) return "Paypal";
  if (g.includes("shopify")) return "Shopify";
  return null;
}

/**
 * Aggregate Net payments by payment day + gateway.
 * Gross sales column = sum of Gross payments (matches early sample days).
 * Order count = unique Order name values.
 */
function aggregatePayments(paymentRows) {
  const byKey = new Map();

  for (const p of paymentRows) {
    const day = isoDay(p["Day"]);
    const gateway = normalizeGateway(p["Payment gateway"]);
    if (!day || !gateway) continue;

    const key = `${day}|${gateway}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        date: day,
        gateway,
        orders: new Set(),
        gross: 0,
        net: 0,
      });
    }
    const bag = byKey.get(key);
    const order = (p["Order name"] || "").trim();
    bag.orders.add(order || `__blank_${bag.orders.size}`);
    bag.gross += num(p["Gross payments"]) || 0;
    bag.net += num(p["Net payments"]) || 0;
  }

  return byKey;
}

/** Merchant fee / GST from fees_inputs.csv (payout reports — not in Shopify exports). */
function loadFeeInputs(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;

  for (const row of readCsv(filePath)) {
    const day = isoDay(row["Date"]);
    const gateway = normalizeGateway(row["Payment gateway"]);
    if (!day || !gateway) continue;
    const fee = num(row["Merchant fee (A$)"]);
    if (fee == null) continue;
    const gstRaw = row["GST on Fee"];
    const gstProvided =
      gstRaw === "" || gstRaw == null ? null : num(gstRaw);
    map.set(`${day}|${gateway}`, { fee, gstProvided });
  }
  return map;
}

function resolveGst(gateway, fee, gstProvided) {
  if (!GST_ON_FEE_GATEWAYS.has(gateway)) return null;
  if (gstProvided != null) return r2(gstProvided);
  return r2(fee / 10);
}

function buildRows(paymentAgg, feeInputs) {
  const keys = new Set([...paymentAgg.keys(), ...feeInputs.keys()]);
  const rows = [];

  for (const key of keys) {
    const [date, gateway] = key.split("|");
    const pay = paymentAgg.get(key) || {
      date,
      gateway,
      orders: new Set(),
      gross: 0,
      net: 0,
    };
    const feeIn = feeInputs.get(key);
    const fee = feeIn ? r2(feeIn.fee) : null;
    const gst =
      fee == null
        ? null
        : resolveGst(gateway, fee, feeIn.gstProvided);
    const feeIncl =
      fee == null ? null : r2(fee + (gst == null ? 0 : gst));
    const rate =
      feeIncl != null && pay.gross
        ? (feeIncl / pay.gross) * 100
        : null;

    rows.push({
      date,
      gateway,
      orders: pay.orders.size,
      gross: r2(pay.gross),
      fee,
      gst,
      feeIncl,
      netDeposit: null,
      rate,
    });
  }

  rows.sort((a, b) => {
    const gi = GATEWAY_ORDER.indexOf(a.gateway);
    const gj = GATEWAY_ORDER.indexOf(b.gateway);
    const ao = gi === -1 ? 99 : gi;
    const bo = gj === -1 ? 99 : gj;
    if (ao !== bo) return ao - bo;
    return a.date.localeCompare(b.date);
  });

  return rows;
}

const HEADER = [
  "Date",
  "Payment gateway",
  "Number of orders",
  "Gross sales (A$)",
  "Merchant fee (A$)",
  "GST on Fee",
  "Merchant Exclude GST(A$)",
  "Net deposit/payout (A$)",
  "Approx Effective fee rate approx (%)",
];

function main() {
  if (!fs.existsSync(PAYMENTS_FILE)) {
    throw new Error(`Missing ${path.basename(PAYMENTS_FILE)}`);
  }

  console.log("Reading payments + fee inputs...");
  const paymentRows = readCsv(PAYMENTS_FILE);
  const paymentAgg = aggregatePayments(paymentRows);
  const feeInputs = loadFeeInputs(INPUTS_FILE);
  console.log(
    `  ${paymentRows.length} payment rows, ${feeInputs.size} fee input rows`
  );

  const rows = buildRows(paymentAgg, feeInputs);

  const body =
    [HEADER.map(csvCell).join(",")]
      .concat(
        rows.map((row) =>
          [
            formatSheetDate(row.date),
            row.gateway,
            String(row.orders),
            formatMoney(row.gross),
            row.fee == null ? "" : formatMoney(row.fee),
            row.gst == null ? "" : formatMoney(row.gst),
            row.feeIncl == null ? "" : formatMoney(row.feeIncl),
            row.netDeposit == null ? "" : formatMoney(row.netDeposit),
            formatRate(row.rate),
          ]
            .map(csvCell)
            .join(",")
        )
      )
      .join("\n") + "\n";

  const written = writeSafely(body);
  console.log(`Wrote ${written}`);
  console.log(`  ${rows.length} gateway/day rows`);

  const withFee = rows.filter((r) => r.fee != null);
  const feeTotal = r2(withFee.reduce((s, r) => s + r.fee, 0));
  const gstTotal = r2(
    withFee.reduce((s, r) => s + (r.gst == null ? 0 : r.gst), 0)
  );
  console.log(`  Merchant fee total ${formatMoney(feeTotal)}, GST on fee ${formatMoney(gstTotal)}`);

  if (!feeInputs.size) {
    console.log(
      `  Note: add ${path.basename(INPUTS_FILE)} with Merchant fee (A$) per date/gateway`
    );
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
