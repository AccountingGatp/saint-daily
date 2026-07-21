# Saint daily report

Upload two Shopify CSVs and download a multi-sheet Excel workbook.

## Structure

- `frontend/` — Next.js + shadcn upload UI (port 3000)
- `backend/` — Express API; processes files in memory only (port 4000)

## Sheets returned

1. **Daily Report** — day-by-day P&L-style metrics  
2. **COGS** — cost / GST columns from sales data  
3. **Country Wise** — net payments by billing country  
4. **Breakdown** — AU + export country daily recon (shipping / GST / refunds) 

## Run

```bash
# Terminal 1 — API
cd final/backend
npm install
npm run dev

# Terminal 2 — UI
cd final/frontend
npm install
npm run dev
```

Open http://localhost:3000, upload:

- Total sales by order CSV  
- Net payments by order CSV  

Then click **Generate report**. The browser downloads an `.xlsx`.

Uploads stay in memory on the server and are not written to disk.
