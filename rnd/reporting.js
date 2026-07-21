const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SALES_FILE = path.join(
  DIR,
  "Total sales by order - 2026-06-01 - 2026-06-30.csv"
);
const COMBINED_FILE = path.join(DIR, "combined.csv");
const PAYMENTS_FILE = path.join(
  DIR,
  "Net payments by order - 2026-06-01 - 2026-06-30 (1).csv"
);
const COGS_FILE = path.join(DIR, "cogs.csv");
const FEES_FILE = path.join(DIR, "fees.csv");
const OUTPUT_FILE = path.join(DIR, "reporting.csv");
const FALLBACK_FILE = path.join(DIR, "reporting_new.csv");

const AUSTRALIA = "Australia";
const YEAR = 2026;

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function number(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/[$,%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return number(value);
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatMoney(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${formatNumber(Math.abs(value), decimals)}`;
}

function formatDisplayDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const monthName = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${day}-${monthName}-${year}`;
}

function isoDay(d) {
  d = String(d || "").trim();
  let m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  m = d.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return `${YEAR}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  return d;
}

function isAustralian(country) {
  return String(country || "")
    .split("|")
    .map((part) => part.trim())
    .includes(AUSTRALIA);
}

function sum(rows, column) {
  return rows.reduce((total, row) => total + number(row[column]), 0);
}

function groupByDay(rows, dayColumn = "Day") {
  const grouped = new Map();
  for (const row of rows) {
    const day = isoDay(row[dayColumn] || row.Date || row.Day);
    if (!day) continue;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(row);
  }
  return grouped;
}

function numericOrderId(orderName) {
  const match = String(orderName || "").trim().match(/^#(\d+)$/);
  return match ? Number(match[1]) : null;
}

function firstOrderRangeStart(orderIds) {
  const sorted = [...new Set(orderIds)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  // Historical returns can appear in a current sales day. The current order
  // block is the final dense sequence after the last material numeric gap.
  let startIndex = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > 10) startIndex = i;
  }
  return sorted[startIndex];
}

function buildOrderRanges(salesByDay, dates) {
  const result = new Map();
  let priorMax = null;

  dates.forEach((date, index) => {
    const ids = (salesByDay.get(date) || [])
      .map((row) => numericOrderId(row["Order name"]))
      .filter((id) => id !== null);
    const max = ids.length ? Math.max(...ids) : null;
    const min = index === 0 ? firstOrderRangeStart(ids) : priorMax + 1;

    result.set(date, {
      range: min !== null && max !== null ? `#${min}-#${max}` : "",
      count: min !== null && max !== null ? max - min + 1 : 0,
    });
    priorMax = max;
  });

  return result;
}

function loadCogsByDate() {
  if (!fs.existsSync(COGS_FILE)) return new Map();
  const map = new Map();
  for (const row of readCsv(COGS_FILE)) {
    const day = isoDay(row.Date);
    if (!day || day === "Total" || String(row.Date).toLowerCase() === "total") {
      continue;
    }
    // Use COGS (AUD after GST removed) so it pairs with Total revenue (ex GST).
    map.set(day, optionalNumber(row.COGS));
  }
  return map;
}

/** Sum merchant fee + GST on fee by payment day from fees.csv. */
function loadFeesByDate() {
  if (!fs.existsSync(FEES_FILE)) return new Map();
  const map = new Map();
  for (const row of readCsv(FEES_FILE)) {
    const day = isoDay(row.Date);
    if (!day) continue;
    if (!map.has(day)) {
      map.set(day, { fee: 0, gst: 0, hasFee: false, hasGst: false });
    }
    const bag = map.get(day);
    const fee = optionalNumber(row["Merchant fee (A$)"]);
    const gst = optionalNumber(row["GST on Fee"]);
    if (fee !== null) {
      bag.fee += fee;
      bag.hasFee = true;
    }
    if (gst !== null) {
      bag.gst += gst;
      bag.hasGst = true;
    }
  }
  for (const bag of map.values()) {
    bag.fee = round2(bag.fee);
    bag.gst = round2(bag.gst);
  }
  return map;
}

function calculateDay(
  date,
  salesRows,
  paymentRows,
  orderInfo,
  supplierCogs,
  feeInfo
) {
  const grossSales = round2(sum(salesRows, "Gross sales"));
  const discounts = round2(sum(salesRows, "Discounts"));
  const returns = round2(sum(salesRows, "Sales reversals"));
  const netSales = round2(sum(salesRows, "Net sales"));
  const shipping = round2(sum(salesRows, "Shipping charges"));
  const taxes = round2(sum(salesRows, "Taxes"));
  const totalSales = round2(sum(salesRows, "Total sales"));

  let productRevenueExGst = 0;
  let shippingAuGross = 0;
  let shippingOther = 0;

  for (const row of salesRows) {
    const productAmount = number(row["Gross sales"]) + number(row.Discounts);
    const shippingAmount = number(row["Shipping charges"]);
    const australian = isAustralian(row["Billing country"]);

    if (row["Product title at time of sale"]) {
      productRevenueExGst += australian ? productAmount / 1.1 : productAmount;
    }

    if (shippingAmount !== 0) {
      if (australian) shippingAuGross += shippingAmount;
      else shippingOther += shippingAmount;
    }
  }

  productRevenueExGst = round2(productRevenueExGst);
  const shippingAuExGst = round2(shippingAuGross / 1.1);
  shippingOther = round2(shippingOther);

  const refund = round2(-sum(paymentRows, "Refunded payments"));
  let refundExGst = 0;
  let refundAuGross = 0;
  for (const row of paymentRows) {
    const refunded = -number(row["Refunded payments"]);
    if (isAustralian(row["Billing country"])) {
      refundAuGross += refunded;
      refundExGst += refunded / 1.1;
    } else {
      refundExGst += refunded;
    }
  }
  refundExGst = round2(refundExGst);
  refundAuGross = round2(refundAuGross);

  const totalRevenueExGst = round2(
    productRevenueExGst + shippingAuExGst + shippingOther - refundExGst
  );
  const grossProfit =
    supplierCogs === null ? null : round2(totalRevenueExGst - supplierCogs);

  const merchantFees = feeInfo?.hasFee ? feeInfo.fee : null;
  const gstOnFee = feeInfo?.hasGst ? feeInfo.gst : null;

  const gstOnShipping = round2(shippingAuGross - shippingAuExGst);
  const gstOnRefundAu = round2(refundAuGross - refundAuGross / 1.1);

  // AU product GST only (non-AU cancels: incl − ex = 0).
  const productInclGstBeforeReturns = salesRows.reduce((total, row) => {
    if (!row["Product title at time of sale"]) return total;
    return total + number(row["Gross sales"]) + number(row.Discounts);
  }, 0);
  const gstOnSalesProduct = round2(
    productInclGstBeforeReturns - productRevenueExGst
  );

  // Sample: "GST on Sales Including Gst on refunds"
  // = AU GST on product + AU GST on shipping + AU GST on refunds
  // (= breakdown "Final GST Payable" + "Refund GST").
  const gstOnSalesIncludingRefunds = round2(
    gstOnSalesProduct + gstOnShipping + gstOnRefundAu
  );
  const netGst =
    gstOnFee === null
      ? null
      : round2(
          gstOnSalesIncludingRefunds + gstOnShipping - gstOnFee - gstOnRefundAu
        );

  return {
    date,
    orderRange: orderInfo.range,
    numberOfOrders: orderInfo.count,
    grossSales,
    discounts,
    returns,
    netSales,
    shipping,
    taxes,
    totalSales,
    productRevenueExGst,
    shippingAuExGst,
    shippingOther,
    refund,
    refundExGst,
    totalRevenueExGst,
    supplierCogs,
    grossProfit,
    merchantFees,
    gstOnSalesIncludingRefunds,
    gstOnShipping,
    gstOnFee,
    gstOnRefundAu,
    netGst,
  };
}

function metric(label, reports, getter, formatter = formatNumber) {
  return [label, ...reports.map((report) => formatter(getter(report)))];
}

function blankRow(columnCount) {
  return Array(columnCount).fill("");
}

function buildReportRows(reports) {
  const columns = reports.length + 1;
  return [
    ["Metric", ...reports.map(() => "Value")],
    metric("Date", reports, (r) => r.date, formatDisplayDate),
    metric("Order range", reports, (r) => r.orderRange, (value) => value),
    metric(
      "Number of orders",
      reports,
      (r) => r.numberOfOrders,
      (value) => String(value)
    ),
    metric("Gross sales (A$)", reports, (r) => r.grossSales),
    metric("Discounts (A$)", reports, (r) => r.discounts),
    metric("Returns", reports, (r) => r.returns),
    metric("Net sales (excluding shipping, A$)", reports, (r) => r.netSales),
    metric("Shipping charges collected (A$)", reports, (r) => r.shipping),
    metric("Rounding(US Tax)", reports, (r) => r.taxes),
    metric("Total sales (A$)", reports, (r) => r.totalSales),
    blankRow(columns),
    metric("Product revenue (ex GST, A$)", reports, (r) => r.productRevenueExGst),
    metric(
      "Shipping revenue (ex GST, A$) - AU",
      reports,
      (r) => r.shippingAuExGst
    ),
    metric("Shipping Revenue - Others", reports, (r) => r.shippingOther),
    metric("Refund", reports, (r) => r.refund),
    metric("Refund Ex GST", reports, (r) => r.refundExGst),
    metric("Total revenue (ex GST, A$)", reports, (r) => r.totalRevenueExGst),
    metric(
      "COGS Supplier Cost Sheet - (A$)",
      reports,
      (r) => r.supplierCogs,
      formatMoney
    ),
    metric("Gross profit - COGS (A$)", reports, (r) => r.grossProfit),
    metric("Merchant fees - total (A$)", reports, (r) => r.merchantFees),
    blankRow(columns),
    ["GST Calculation", ...reports.map(() => "")],
    ["Output", ...reports.map(() => "")],
    metric(
      "GST on Sales Including Gst on refunds",
      reports,
      (r) => r.gstOnSalesIncludingRefunds,
      formatMoney
    ),
    metric("GST on Shipping ", reports, (r) => r.gstOnShipping, formatMoney),
    ["Input", ...reports.map(() => "")],
    metric("GST on Fee ", reports, (r) => r.gstOnFee, formatMoney),
    metric(
      "GST on Refund- AU",
      reports,
      (r) => r.gstOnRefundAu,
      (value) => {
        if (value === null || value === undefined || !Number.isFinite(value)) {
          return "";
        }
        return formatNumber(value);
      }
    ),
    blankRow(columns),
    metric("", reports, (r) => r.netGst, formatMoney),
  ];
}

function writeSafely(body) {
  try {
    fs.writeFileSync(OUTPUT_FILE, body, "utf8");
    return OUTPUT_FILE;
  } catch (error) {
    if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
    fs.writeFileSync(FALLBACK_FILE, body, "utf8");
    console.warn(
      `${path.basename(OUTPUT_FILE)} locked — wrote ${path.basename(FALLBACK_FILE)}`
    );
    return FALLBACK_FILE;
  }
}

function main() {
  for (const file of [SALES_FILE, COMBINED_FILE, PAYMENTS_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`Missing ${path.basename(file)}`);
  }

  console.log("Reading sales, payments, COGS, fees...");
  const salesRows = readCsv(SALES_FILE);
  const combinedRows = readCsv(COMBINED_FILE);
  const paymentRows = readCsv(PAYMENTS_FILE);
  const salesByDay = groupByDay(salesRows);
  const combinedByDay = groupByDay(combinedRows);
  const paymentsByDay = groupByDay(paymentRows);
  const dates = [...salesByDay.keys()].sort();
  const orderRanges = buildOrderRanges(salesByDay, dates);
  const cogsByDate = loadCogsByDate();
  const feesByDate = loadFeesByDate();

  const reports = dates.map((date) =>
    calculateDay(
      date,
      combinedByDay.get(date) || [],
      paymentsByDay.get(date) || [],
      orderRanges.get(date),
      cogsByDate.get(date) ?? null,
      feesByDate.get(date)
    )
  );

  const reportRows = buildReportRows(reports);
  const body =
    reportRows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  const written = writeSafely(body);

  console.log(`Wrote ${written}`);
  console.log(`  ${reports.length} daily columns`);
  console.log(`  cogs.csv days: ${cogsByDate.size}, fees.csv days: ${feesByDate.size}`);
  if (reports[0]) {
    console.log(
      `  sample ${formatDisplayDate(reports[0].date)}: orders ${reports[0].numberOfOrders}, gross ${formatNumber(reports[0].grossSales)}, fees ${formatNumber(reports[0].merchantFees)}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
