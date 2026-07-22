"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FileSlot = "sales" | "payments";

export default function Home() {
  const [sales, setSales] = useState<File | null>(null);
  const [payments, setPayments] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const salesRef = useRef<HTMLInputElement>(null);
  const paymentsRef = useRef<HTMLInputElement>(null);

  function onPick(slot: FileSlot, file: File | null) {
    setError(null);
    setOk(null);
    if (slot === "sales") setSales(file);
    else setPayments(file);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);

    if (!sales || !payments) {
      setError("Upload both CSV files before generating the report.");
      return;
    }

    setLoading(true);
    try {
      const form = new FormData();
      form.append("sales", sales);
      form.append("payments", payments);

      const apiBase = (
        process.env.NEXT_PUBLIC_API_URL || ""
      ).replace(/\/$/, "");
      const res = await fetch(`${apiBase}/api/report`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Request failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/i);
      const filename = match?.[1] || "daily-report.xlsx";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setOk(`Downloaded ${filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_oklch(0.96_0.02_250)_0%,_transparent_55%),linear-gradient(180deg,_oklch(0.985_0.01_90)_0%,_oklch(0.97_0.015_200)_100%)]"
      />
      <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-12">
        <p className="mb-2 text-sm font-medium tracking-wide text-muted-foreground">
          Saint
        </p>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Daily report builder
        </h1>
        <p className="mb-8 max-w-lg text-muted-foreground">
          Upload Shopify Total sales and Net payments exports. The API combines
          them in memory and returns an Excel workbook — Daily Report, COGS,
          Country Wise, and Breakdown.
        </p>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <FileSpreadsheet className="size-5" />
              Upload CSVs
            </CardTitle>
            <CardDescription>
              Files are sent to the backend and never saved to disk.
            </CardDescription>
          </CardHeader>

          <form onSubmit={onSubmit}>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="sales">Total sales by order</Label>
                <Input
                  id="sales"
                  ref={salesRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) =>
                    onPick("sales", e.target.files?.[0] ?? null)
                  }
                />
                {sales ? (
                  <p className="text-xs text-muted-foreground">{sales.name}</p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="payments">Net payments by order</Label>
                <Input
                  id="payments"
                  ref={paymentsRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) =>
                    onPick("payments", e.target.files?.[0] ?? null)
                  }
                />
                {payments ? (
                  <p className="text-xs text-muted-foreground">
                    {payments.name}
                  </p>
                ) : null}
              </div>

              {error ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {ok ? (
                <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
                  {ok}
                </p>
              ) : null}
            </CardContent>

            <CardFooter className="justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => {
                  setSales(null);
                  setPayments(null);
                  setError(null);
                  setOk(null);
                  if (salesRef.current) salesRef.current.value = "";
                  if (paymentsRef.current) paymentsRef.current.value = "";
                }}
              >
                Clear
              </Button>
              <Button type="submit" disabled={loading || !sales || !payments}>
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Building…
                  </>
                ) : (
                  <>
                    <Upload className="size-4" />
                    Generate report
                  </>
                )}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </main>
  );
}
