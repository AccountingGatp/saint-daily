const { number, round2, isoDay } = require("./csv");

const AUSTRALIA = "Australia";

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

/**
 * Same day metrics as rnd/reporting.js calculateDay.
 * supplierCogs / feeInfo are optional (null when not provided).
 */
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

/** Same layout as rnd/reporting.js buildReportRows. */
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

/**
 * Build Daily Report sheet (same as rnd/reporting.csv).
 * Uses combined sales+payments rows for sale-day metrics and payments for refunds.
 * COGS / merchant fees stay blank without supplier_costs / fees_inputs.
 */
function buildDailyReportSheet(salesRows, combinedRows, paymentRows) {
  const salesByDay = groupByDay(salesRows);
  const combinedByDay = groupByDay(combinedRows);
  const paymentsByDay = groupByDay(paymentRows);
  const dates = [...salesByDay.keys()].sort();
  const orderRanges = buildOrderRanges(salesByDay, dates);

  const reports = dates.map((date) =>
    calculateDay(
      date,
      combinedByDay.get(date) || [],
      paymentsByDay.get(date) || [],
      orderRanges.get(date),
      null, // no cogs.csv in 2-file upload flow
      undefined // no fees.csv
    )
  );

  return buildReportRows(reports);
}

module.exports = { buildDailyReportSheet };
