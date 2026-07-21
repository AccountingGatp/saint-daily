const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { buildWorkbook } = require("./process");

const app = express();
const PORT = process.env.PORT || 4000;

/** Keep uploads in memory only — never write to disk. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    exposedHeaders: ["Content-Disposition"],
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/report
 * multipart fields:
 *   sales    - Total sales by order CSV
 *   payments - Net payments by order CSV
 * Returns an .xlsx with sheets: Daily Report, COGS, Country Wise, Breakdown
 */
app.post(
  "/api/report",
  upload.fields([
    { name: "sales", maxCount: 1 },
    { name: "payments", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const salesFile = req.files?.sales?.[0];
      const paymentsFile = req.files?.payments?.[0];

      if (!salesFile || !paymentsFile) {
        return res.status(400).json({
          error:
            "Upload both files: 'sales' (Total sales by order) and 'payments' (Net payments by order)",
        });
      }

      const buffer = await buildWorkbook(salesFile.buffer, paymentsFile.buffer);
      const filename = `daily-report-${new Date().toISOString().slice(0, 10)}.xlsx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.send(buffer);
    } catch (err) {
      console.error(err);
      res.status(400).json({
        error: err.message || "Failed to build report",
      });
    }
  }
);

// Local / traditional host — Vercel uses the exported app instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Saint report API listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
