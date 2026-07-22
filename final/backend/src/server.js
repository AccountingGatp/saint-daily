// Load .env for local dev; harmless (and skipped) if dotenv isn't installed.
try {
  require("dotenv").config();
} catch {}

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { buildWorkbook } = require("./process");
const {
  makeKey,
  presignPut,
  getObjectBuffer,
  assertDailyKey,
} = require("./b2");

const app = express();
const PORT = process.env.PORT || 4000;

/** Keep uploads in memory only — never write to disk. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

app.use(
  cors({
    origin: true,
    exposedHeaders: ["Content-Disposition"],
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/upload-url
 * body: { salesName?, paymentsName? }
 * Returns presigned PUT URLs so the browser uploads CSVs straight to B2,
 * bypassing the serverless request-body size limit.
 */
app.post("/api/upload-url", async (req, res) => {
  try {
    const { salesName, paymentsName } = req.body || {};
    const salesKey = makeKey("sales", salesName);
    const paymentsKey = makeKey("payments", paymentsName);

    const [salesUrl, paymentsUrl] = await Promise.all([
      presignPut(salesKey),
      presignPut(paymentsKey),
    ]);

    res.json({
      sales: { key: salesKey, url: salesUrl },
      payments: { key: paymentsKey, url: paymentsUrl },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to sign upload URLs" });
  }
});

/**
 * POST /api/report
 * Preferred (B2): JSON body { salesKey, paymentsKey } — files already uploaded
 *   to Backblaze via the presigned URLs from /api/upload-url. Backend downloads
 *   them server-side, so there is no request-body size limit.
 * Fallback (small files): multipart fields `sales` and `payments`.
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
      const { salesKey, paymentsKey } = req.body || {};
      let salesBuffer;
      let paymentsBuffer;

      if (salesKey && paymentsKey) {
        assertDailyKey(salesKey);
        assertDailyKey(paymentsKey);
        [salesBuffer, paymentsBuffer] = await Promise.all([
          getObjectBuffer(salesKey),
          getObjectBuffer(paymentsKey),
        ]);
      } else {
        const salesFile = req.files?.sales?.[0];
        const paymentsFile = req.files?.payments?.[0];
        if (!salesFile || !paymentsFile) {
          return res.status(400).json({
            error:
              "Provide { salesKey, paymentsKey } from /api/upload-url, or upload both 'sales' and 'payments' files.",
          });
        }
        salesBuffer = salesFile.buffer;
        paymentsBuffer = paymentsFile.buffer;
      }

      const buffer = await buildWorkbook(salesBuffer, paymentsBuffer);
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
