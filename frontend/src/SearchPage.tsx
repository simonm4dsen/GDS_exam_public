import { useMemo, useState } from "react";
import { ColumnLayer } from "@deck.gl/layers";
import MapView from "./MapView";
import { searchAddress, type SearchResult } from "./api";
import { colorForValue, type PaletteName, PALETTE_NAMES } from "./palettes";

interface SaleRow {
  address: string;
  year: number;
  adjustedSqmPrice: number;
  squareMeters: number | null;
  salePrice: number | null;
}

interface SaleStats {
  rows: SaleRow[];
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  minYear: number;
  maxYear: number;
}

function computeStats(result: SearchResult): SaleStats | null {
  const rows: SaleRow[] = result.apartments.features
    .map((f) => {
      const p = f.properties as any;
      const price = p.adjusted_sqm_price;
      if (typeof price !== "number" || Number.isNaN(price)) return null;
      return {
        address: (p.tooltip_address ?? p.address ?? "").toString(),
        year: Number(p.year),
        adjustedSqmPrice: price,
        squareMeters: typeof p.square_meters === "number" ? p.square_meters : null,
        salePrice: typeof p.latest_sale_price === "number" ? p.latest_sale_price : null,
      };
    })
    .filter((r): r is SaleRow => r !== null)
    .sort((a, b) => b.year - a.year || b.adjustedSqmPrice - a.adjustedSqmPrice);

  if (rows.length === 0) return null;

  const prices = rows.map((r) => r.adjustedSqmPrice).sort((a, b) => a - b);
  const years = rows.map((r) => r.year);
  const sum = prices.reduce((a, b) => a + b, 0);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

  return {
    rows,
    count: rows.length,
    min: prices[0],
    max: prices[prices.length - 1],
    mean: sum / prices.length,
    median,
    minYear: Math.min(...years),
    maxYear: Math.max(...years),
  };
}

function fmt(n: number, digits = 0) {
  return n.toLocaleString("da-DK", { maximumFractionDigits: digits });
}

function PriceHistogram({ prices }: { prices: number[] }) {
  const width = 480;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 24, left: 36 };
  const bucketCount = 16;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const bucketSize = span / bucketCount;

  const buckets = new Array(bucketCount).fill(0);
  for (const p of prices) {
    const idx = Math.min(bucketCount - 1, Math.floor((p - min) / bucketSize));
    buckets[idx] += 1;
  }
  const maxCount = Math.max(...buckets, 1);

  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const barGap = 2;
  const barW = innerW / bucketCount - barGap;

  return (
    <svg width={width} height={height} role="img" aria-label="Price distribution histogram">
      {buckets.map((count, i) => {
        const barH = (count / maxCount) * innerH;
        const x = padding.left + i * (innerW / bucketCount) + barGap / 2;
        const y = padding.top + (innerH - barH);
        return (
          <g key={i}>
            <rect x={x} y={y} width={Math.max(barW, 1)} height={barH} fill="#4fa8ff" opacity={0.85} />
            {count > 0 && (
              <text x={x + barW / 2} y={y - 3} fontSize={9} textAnchor="middle" fill="#ccc">
                {count}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1={padding.left}
        y1={padding.top + innerH}
        x2={width - padding.right}
        y2={padding.top + innerH}
        stroke="#555"
      />
      <text x={padding.left} y={height - 6} fontSize={10} fill="#aaa">
        {fmt(min)}
      </text>
      <text x={width - padding.right} y={height - 6} fontSize={10} fill="#aaa" textAnchor="end">
        {fmt(max)}
      </text>
    </svg>
  );
}

export default function SearchPage() {
  const [text, setText] = useState("");
  const [minAddresses, setMinAddresses] = useState(5);
  const [minApartments, setMinApartments] = useState(50);
  const [palette, setPalette] = useState<PaletteName>("Viridis");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await searchAddress(text, minAddresses, minApartments);
      setResult(r);
    } catch (e: any) {
      setError(String(e.message ?? e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const layers = useMemo(() => {
    if (!result) return [];
    const props = result.apartments.features.map((f) => f.properties as any);
    const values = props.map((p) => p.adjusted_sqm_price).filter((v) => typeof v === "number");
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;

    return [
      new ColumnLayer({
        id: "search-results",
        data: result.apartments.features,
        radius: 8,
        extruded: true,
        pickable: true,
        elevationScale: 250,
        getPosition: (f: any) => f.geometry.coordinates,
        getElevation: (f: any) => ((f.properties.adjusted_sqm_price ?? min) - min) / span,
        getFillColor: (f: any) => colorForValue(((f.properties.adjusted_sqm_price ?? min) - min) / span, palette),
      }),
    ];
  }, [result, palette]);

  const stats = useMemo(() => (result ? computeStats(result) : null), [result]);

  const tooltip = (info: any) => {
    const p = info.object?.properties;
    if (!p) return null;
    return `<b>${p.tooltip_address ?? p.address ?? ""}</b><br/>${p.tooltip_price ?? ""} kr/m²`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="controls">
        <input
          style={{ flex: 2, minWidth: 260 }}
          placeholder="… Kongens Nytorv 1, 1050 København K"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <label>
          Min. adjacent addresses
          <select value={minAddresses} onChange={(e) => setMinAddresses(Number(e.target.value))}>
            {Array.from({ length: 25 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min. apartments
          <select value={minApartments} onChange={(e) => setMinApartments(Number(e.target.value))}>
            {Array.from({ length: 10 }, (_, i) => (i + 1) * 10).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Palette
          <select value={palette} onChange={(e) => setPalette(e.target.value as PaletteName)}>
            {PALETTE_NAMES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <button onClick={handleSearch} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {result && (
        <div className="result-banner">
          Matched "{result.query}" to <b>{result.matched_address}</b> — {result.count} apartments on nearby addresses
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MapView
            layers={layers}
            initialViewState={{
              longitude: result?.lng ?? 12.56,
              latitude: result?.lat ?? 55.67,
              zoom: result ? 15 : 10,
              pitch: 45,
            }}
            getTooltip={tooltip}
          />
        </div>

        {stats && (
          <div
            style={{
              width: 460,
              flexShrink: 0,
              overflowY: "auto",
              padding: "12px 16px",
              borderLeft: "1px solid #333",
              background: "#161616",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Sale summary</h3>
            <div className="stats-grid">
              <div>
                <span className="stat-label">Sales found</span>
                <span className="stat-value">{stats.count}</span>
              </div>
              <div>
                <span className="stat-label">Year range</span>
                <span className="stat-value">
                  {stats.minYear}–{stats.maxYear}
                </span>
              </div>
              <div>
                <span className="stat-label">Median kr/m²</span>
                <span className="stat-value">{fmt(stats.median)}</span>
              </div>
              <div>
                <span className="stat-label">Mean kr/m²</span>
                <span className="stat-value">{fmt(stats.mean)}</span>
              </div>
              <div>
                <span className="stat-label">Min kr/m²</span>
                <span className="stat-value">{fmt(stats.min)}</span>
              </div>
              <div>
                <span className="stat-label">Max kr/m²</span>
                <span className="stat-value">{fmt(stats.max)}</span>
              </div>
            </div>

            <h4>Price distribution</h4>
            <PriceHistogram prices={stats.rows.map((r) => r.adjustedSqmPrice)} />

            <h4>Sales by year</h4>
            <div style={{ overflowX: "auto" }}>
              <table className="sales-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Kr/m²</th>
                    <th>m²</th>
                    <th>Address</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.year}</td>
                      <td>{fmt(r.adjustedSqmPrice)}</td>
                      <td>{r.squareMeters != null ? fmt(r.squareMeters, 1) : "—"}</td>
                      <td>{r.address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
