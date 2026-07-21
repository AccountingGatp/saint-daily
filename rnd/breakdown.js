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
const OUTPUT_FILE = path.join(DIR, "breakdown.csv");
const FALLBACK_FILE = path.join(DIR, "breakdown_new.csv");

const GST_RATE = 0.1;
const DIV = 1 + GST_RATE;
const AU = "Australia";
const NO_COUNTRY = "(No billing country)";

/** Mapped countries first (stable order), then remaining countries A–Z. */
const MAPPED_ORDER = [
  "United States",
  "New Zealand",
  "Canada",
  "United Kingdom",
  "Singapore",
];

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : 0;
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

/** Normalise a day to ISO YYYY-MM-DD. */
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

function formatNumber(n) {
  if (n === 0) return "0";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

/**
 * Build per-day country breakdown using the same rules as the
 * reconciliation journal (shipping on sale day, cash/refunds/tax on payment day).
 */
function buildBreakdown(salesRows, paymentRows) {
  // order -> total tax from sales lines
  const orderTax = {};
  for (const s of salesRows) {
    const o = (s["Order name"] || "").trim();
    if (!o) continue;
    orderTax[o] = (orderTax[o] || 0) + num(s["Taxes"]);
  }

  // order -> billing country from payments
  const orderCountry = {};
  for (const p of paymentRows) {
    const o = (p["Order name"] || "").trim();
    if (o && !orderCountry[o]) {
      orderCountry[o] =
        (p["Billing country"] || "").trim() || NO_COUNTRY;
    }
  }

  const grossByC = {}; // day -> country -> gross payments
  const refundByC = {}; // day -> country -> refund magnitude (positive)
  const shipByC = {}; // day -> country -> shipping (sale day)
  const taxByC = {}; // day -> country -> other tax (payment day)
  const days = new Set();

  // Shipping booked on SALE day, attributed via payment billing country.
  for (const s of salesRows) {
    const day = isoDay(s["Day"]);
    if (!day) continue;
    days.add(day);
    const country =
      orderCountry[(s["Order name"] || "").trim()] || NO_COUNTRY;
    (shipByC[day] = shipByC[day] || {})[country] =
      (shipByC[day][country] || 0) + num(s["Shipping charges"]);
  }

  // Payments drive gross / refund on PAYMENT day.
  // Other tax is booked once per order (on the first payment day), so multi-
  // payment orders don't inflate the tax column.
  const taxBooked = new Set();
  for (const p of paymentRows) {
    const day = isoDay(p["Day"]);
    if (!day) continue;
    days.add(day);
    const country =
      (p["Billing country"] || "").trim() || NO_COUNTRY;
    const gross = num(p["Gross payments"]);
    const refund = Math.abs(num(p["Refunded payments"]));
    const o = (p["Order name"] || "").trim();

    (grossByC[day] = grossByC[day] || {})[country] =
      (grossByC[day][country] || 0) + gross;
    (refundByC[day] = refundByC[day] || {})[country] =
      (refundByC[day][country] || 0) + refund;

    if (o && !taxBooked.has(o)) {
      taxBooked.add(o);
      (taxByC[day] = taxByC[day] || {})[country] =
        (taxByC[day][country] || 0) + (orderTax[o] || 0);
    }
  }

  // Collect export countries across the whole period (exclude AU + no-country).
  const exportCountries = new Set();
  for (const day of days) {
    for (const bag of [grossByC[day], shipByC[day], refundByC[day], taxByC[day]]) {
      for (const c of Object.keys(bag || {})) {
        if (c !== AU && c !== NO_COUNTRY) exportCountries.add(c);
      }
    }
  }

  const others = [...exportCountries]
    .filter((c) => !MAPPED_ORDER.includes(c))
    .sort((a, b) => a.localeCompare(b));
  const countryOrder = [
    ...MAPPED_ORDER.filter((c) => exportCountries.has(c)),
    ...others,
  ];

  const sortedDays = [...days].sort();
  const rows = [];

  for (const day of sortedDays) {
    const gross = grossByC[day] || {};
    const refund = refundByC[day] || {};
    const ship = shipByC[day] || {};
    const tax = taxByC[day] || {};

    // ----- Australia (GST-inclusive) -----
    const auGross = gross[AU] || 0;
    const auShipIncl = r2(ship[AU] || 0);
    const auShipEx = r2(auShipIncl / DIV);
    const auGstOnShip = r2(auShipIncl - auShipEx);
    const auRevIncl = r2(auGross - auShipIncl);
    const auRevEx = r2(auRevIncl / DIV);
    const auGstOnSales = r2(auRevIncl - auRevEx);
    const auTotalGst = r2(auGstOnSales + auGstOnShip);
    const auRefundIncl = r2(refund[AU] || 0);
    const auRefundEx = r2(auRefundIncl / DIV);
    const auGstOnRefund = r2(auRefundIncl - auRefundEx);

    const row = {
      Date: day,
      Sales_Revenue_AUS: r2(auRevEx),
      // Recon sheet: "Shipping (Australia, excl. GST)" = ship / 1.1
      "FINAL Shipping_AUS": r2(auShipEx),
      // Header says "on Shipping" but value is total GST payable
      // (GST on sales + GST on shipping), matching the recon sheet.
      "Final GST Payable on Shipping": r2(auTotalGst),
      "Refund_AUS(Including GST )": r2(-auRefundIncl),
      "Refund GST( Excluding GST)": r2(-auRefundEx),
      "Refund GST": r2(-auGstOnRefund),
    };

    // ----- Export countries -----
    // Sales revenue = gross payments - shipping - other tax
    for (const c of countryOrder) {
      const salesRev = (gross[c] || 0) - (ship[c] || 0) - (tax[c] || 0);
      row[`Sales Revenue (${c})`] = r2(salesRev);
      row[`Shipping (${c})`] = r2(ship[c] || 0);
      row[`Other Tax (${c})`] = r2(tax[c] || 0);
      row[`Refunds (${c})`] = r2(-(refund[c] || 0));
    }

    rows.push(row);
  }

  return { rows, countryOrder };
}

function buildHeader(countryOrder) {
  const header = [
    "Date",
    "Sales_Revenue_AUS",
    "FINAL Shipping_AUS",
    "Final GST Payable on Shipping",
    "Refund_AUS(Including GST )",
    "Refund GST( Excluding GST)",
    "Refund GST",
  ];
  for (const c of countryOrder) {
    header.push(
      `Sales Revenue (${c})`,
      `Shipping (${c})`,
      `Other Tax (${c})`,
      `Refunds (${c})`
    );
  }
  return header;
}

function main() {
  for (const file of [SALES_FILE, PAYMENTS_FILE]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing ${path.basename(file)}`);
    }
  }

  console.log("Reading sales + payments...");
  const salesRows = readCsv(SALES_FILE);
  const paymentRows = readCsv(PAYMENTS_FILE);
  console.log(`  ${salesRows.length} sales rows, ${paymentRows.length} payment rows`);

  const { rows, countryOrder } = buildBreakdown(salesRows, paymentRows);
  const header = buildHeader(countryOrder);

  const totals = { Date: "Total" };
  for (const h of header) {
    if (h === "Date") continue;
    totals[h] = r2(rows.reduce((s, row) => s + (row[h] || 0), 0));
  }

  const body =
    [header.map(csvCell).join(",")]
      .concat(
        rows.map((row) =>
          header
            .map((h) =>
              csvCell(h === "Date" ? row.Date : formatNumber(row[h] ?? 0))
            )
            .join(",")
        )
      )
      .concat([
        header
          .map((h) =>
            csvCell(h === "Date" ? "Total" : formatNumber(totals[h] ?? 0))
          )
          .join(","),
      ])
      .join("\n") + "\n";

  const written = writeSafely(body);
  console.log(`Wrote ${written}`);
  console.log(`  ${rows.length} days, ${countryOrder.length} export countries`);
  console.log(
    `  Totals: AU rev ${totals.Sales_Revenue_AUS}, AU ship ${totals["FINAL Shipping_AUS"]}, GST ${totals["Final GST Payable on Shipping"]}`
  );
  console.log(
    `  US rev ${totals["Sales Revenue (United States)"]}, US ship ${totals["Shipping (United States)"]}, NZ rev ${totals["Sales Revenue (New Zealand)"]}, NZ ship ${totals["Shipping (New Zealand)"]}`
  );
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
