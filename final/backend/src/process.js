const ExcelJS = require("exceljs");
const { parseCsvBuffer } = require("./csv");
const {
  combineSalesAndPayments,
  buildCogsSheet,
  buildCountrySheet,
} = require("./combine");
const { buildDailyReportSheet } = require("./reporting");
const { buildBreakdownSheet } = require("./breakdown");

function writeSheet(workbook, name, matrix) {
  const sheet = workbook.addWorksheet(name);
  for (const row of matrix) {
    const values = row.map((cell) =>
      cell === null || cell === undefined ? "" : cell
    );
    sheet.addRow(values);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Build multi-sheet workbook from two Shopify CSV buffers (no disk writes).
 * @param {Buffer} salesBuffer - Total sales by order CSV
 * @param {Buffer} paymentsBuffer - Net payments by order CSV
 * @returns {Promise<Buffer>} xlsx file buffer
 */
async function buildWorkbook(salesBuffer, paymentsBuffer) {
  const sales = parseCsvBuffer(salesBuffer);
  const payments = parseCsvBuffer(paymentsBuffer);

  if (!sales.rows.length) throw new Error("Sales CSV has no data rows");
  if (!payments.rows.length) throw new Error("Payments CSV has no data rows");

  if (!sales.headers.includes("Order name") || !sales.headers.includes("Day")) {
    throw new Error(
      "Sales file must be a Shopify 'Total sales by order' export (needs Day, Order name)"
    );
  }
  if (
    !payments.headers.includes("Order name") ||
    !payments.headers.includes("Net payments")
  ) {
    throw new Error(
      "Payments file must be a Shopify 'Net payments by order' export (needs Order name, Net payments)"
    );
  }

  const combinedRows = combineSalesAndPayments(
    sales.rows,
    sales.headers,
    payments.rows
  );

  const dailyReport = buildDailyReportSheet(
    sales.rows,
    combinedRows,
    payments.rows
  );
  const cogsSheet = buildCogsSheet(sales.rows);
  const countrySheet = buildCountrySheet(payments.rows);
  const breakdownSheet = buildBreakdownSheet(sales.rows, payments.rows);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Saint Daily Report";
  workbook.created = new Date();

  writeSheet(workbook, "Daily Report", dailyReport);
  writeSheet(workbook, "COGS", cogsSheet);
  writeSheet(workbook, "Country Wise", countrySheet);
  writeSheet(workbook, "Breakdown", breakdownSheet);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { buildWorkbook };
