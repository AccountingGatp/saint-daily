const { number, round2, isoDay } = require("./csv");

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

    agg["Gross payments"] += number(row["Gross payments"]);
    agg["Refunded payments"] += number(row["Refunded payments"]);
    agg["Net payments"] += number(row["Net payments"]);
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

/** Join sales rows to aggregated payments (same as rnd/combine.js). */
function combineSalesAndPayments(salesRows, salesHeaders, paymentRows) {
  const paymentsByOrder = aggregatePayments(paymentRows);
  return salesRows.map((sale) => {
    const pay = paymentsByOrder.get(sale["Order name"]);
    const row = {};
    for (const h of salesHeaders) row[h] = sale[h] ?? "";
    for (const col of PAYMENT_COLUMNS) {
      row[col] = pay ? pay[col] ?? "" : "";
    }
    return row;
  });
}

function buildCogsSheet(salesRows) {
  const byDay = new Map();
  for (const row of salesRows) {
    const day = isoDay(row["Day"]);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, { product: 0, shipping: 0 });
    }
    const bag = byDay.get(day);
    bag.product += number(row["Net sales"]);
    bag.shipping += number(row["Shipping charges"]);
  }

  const dates = [...byDay.keys()].sort();
  const headers = [
    "Date",
    "Product (Net sales A$)",
    "Shipping charges (A$)",
    "Total (A$)",
    "GST (A$)",
    "COGS ex GST (A$)",
  ];
  const rows = [headers];
  let tProduct = 0;
  let tShip = 0;
  let tTotal = 0;
  let tGst = 0;
  let tCogs = 0;

  for (const day of dates) {
    const { product, shipping } = byDay.get(day);
    const p = round2(product);
    const s = round2(shipping);
    const total = round2(p + s);
    const gst = round2(total / 11);
    const cogs = round2(total - gst);
    tProduct += p;
    tShip += s;
    tTotal += total;
    tGst += gst;
    tCogs += cogs;
    const md = day.slice(5).replace("-", "/");
    rows.push([md, p, s, total, gst, cogs]);
  }

  rows.push([]);
  rows.push([
    "Total",
    round2(tProduct),
    round2(tShip),
    round2(tTotal),
    round2(tGst),
    round2(tCogs),
  ]);

  return rows;
}

function buildCountrySheet(paymentRows) {
  const byCountry = new Map();
  let minDay = null;
  let maxDay = null;

  for (const row of paymentRows) {
    const day = isoDay(row["Day"]);
    if (day) {
      if (!minDay || day < minDay) minDay = day;
      if (!maxDay || day > maxDay) maxDay = day;
    }
    const country = (row["Billing country"] || "").trim() || "United States";
    byCountry.set(country, (byCountry.get(country) || 0) + number(row["Net payments"]));
  }

  const entries = [...byCountry.entries()]
    .map(([country, revenue]) => ({ country, revenue: round2(revenue) }))
    .sort((a, b) => a.country.localeCompare(b.country));
  const total = round2(entries.reduce((s, e) => s + e.revenue, 0));

  const fmtRange = (iso) => {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  };
  const rangeLabel =
    minDay && maxDay
      ? `${fmtRange(minDay)} to ${fmtRange(maxDay)}`
      : "Country sales";

  const rows = [
    [rangeLabel, "", ""],
    [],
    ["Country", "Revenue (ex GST)", "Percentage (ex GST)"],
  ];

  for (const { country, revenue } of entries) {
    const rawPct = total === 0 ? 0 : (revenue / total) * 100;
    const pct = round2(Math.abs(rawPct) < 0.005 ? 0 : rawPct);
    rows.push([`Product Revenue ${country}`, revenue, pct]);
  }
  rows.push([]);
  rows.push(["Total", total, 100]);
  return rows;
}

module.exports = {
  combineSalesAndPayments,
  buildCogsSheet,
  buildCountrySheet,
};
