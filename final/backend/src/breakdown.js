const { number, round2, isoDay } = require("./csv");

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

/**
 * Build per-day country breakdown (same rules as rnd/breakdown.js).
 * Shipping on sale day; gross / refunds / tax on payment day.
 * @returns {string[][]} matrix for Excel
 */
function buildBreakdownSheet(salesRows, paymentRows) {
  const orderTax = {};
  for (const s of salesRows) {
    const o = (s["Order name"] || "").trim();
    if (!o) continue;
    orderTax[o] = (orderTax[o] || 0) + number(s["Taxes"]);
  }

  const orderCountry = {};
  for (const p of paymentRows) {
    const o = (p["Order name"] || "").trim();
    if (o && !orderCountry[o]) {
      orderCountry[o] = (p["Billing country"] || "").trim() || NO_COUNTRY;
    }
  }

  const grossByC = {};
  const refundByC = {};
  const shipByC = {};
  const taxByC = {};
  const days = new Set();

  for (const s of salesRows) {
    const day = isoDay(s["Day"]);
    if (!day) continue;
    days.add(day);
    const country =
      orderCountry[(s["Order name"] || "").trim()] || NO_COUNTRY;
    (shipByC[day] = shipByC[day] || {})[country] =
      (shipByC[day][country] || 0) + number(s["Shipping charges"]);
  }

  const taxBooked = new Set();
  for (const p of paymentRows) {
    const day = isoDay(p["Day"]);
    if (!day) continue;
    days.add(day);
    const country = (p["Billing country"] || "").trim() || NO_COUNTRY;
    const gross = number(p["Gross payments"]);
    const refund = Math.abs(number(p["Refunded payments"]));
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

  const exportCountries = new Set();
  for (const day of days) {
    for (const bag of [
      grossByC[day],
      shipByC[day],
      refundByC[day],
      taxByC[day],
    ]) {
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

  const sortedDays = [...days].sort();
  const dataRows = [];

  for (const day of sortedDays) {
    const gross = grossByC[day] || {};
    const refund = refundByC[day] || {};
    const ship = shipByC[day] || {};
    const tax = taxByC[day] || {};

    const auGross = gross[AU] || 0;
    const auShipIncl = round2(ship[AU] || 0);
    const auShipEx = round2(auShipIncl / DIV);
    const auGstOnShip = round2(auShipIncl - auShipEx);
    const auRevIncl = round2(auGross - auShipIncl);
    const auRevEx = round2(auRevIncl / DIV);
    const auGstOnSales = round2(auRevIncl - auRevEx);
    const auTotalGst = round2(auGstOnSales + auGstOnShip);
    const auRefundIncl = round2(refund[AU] || 0);
    const auRefundEx = round2(auRefundIncl / DIV);
    const auGstOnRefund = round2(auRefundIncl - auRefundEx);

    const row = {
      Date: day,
      Sales_Revenue_AUS: round2(auRevEx),
      "FINAL Shipping_AUS": round2(auShipEx),
      "Final GST Payable on Shipping": round2(auTotalGst),
      "Refund_AUS(Including GST )": round2(-auRefundIncl),
      "Refund GST( Excluding GST)": round2(-auRefundEx),
      "Refund GST": round2(-auGstOnRefund),
    };

    for (const c of countryOrder) {
      const salesRev = (gross[c] || 0) - (ship[c] || 0) - (tax[c] || 0);
      row[`Sales Revenue (${c})`] = round2(salesRev);
      row[`Shipping (${c})`] = round2(ship[c] || 0);
      row[`Other Tax (${c})`] = round2(tax[c] || 0);
      row[`Refunds (${c})`] = round2(-(refund[c] || 0));
    }

    dataRows.push(row);
  }

  const totals = { Date: "Total" };
  for (const h of header) {
    if (h === "Date") continue;
    totals[h] = round2(dataRows.reduce((s, row) => s + (row[h] || 0), 0));
  }

  const matrix = [header];
  for (const row of dataRows) {
    matrix.push(header.map((h) => (h === "Date" ? row.Date : row[h] ?? 0)));
  }
  matrix.push(header.map((h) => (h === "Date" ? "Total" : totals[h] ?? 0)));

  return matrix;
}

module.exports = { buildBreakdownSheet };
