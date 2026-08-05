import { useMemo, useState } from "react";
import { ColumnLayer, ScatterplotLayer } from "@deck.gl/layers";
import MapView from "./MapView";
import { searchAddress, type SearchResult } from "./api";
import { colorForValue, type PaletteName } from "./palettes";
import type { Theme } from "./useTheme";

interface SaleRow {
  address: string;
  year: number;
  adjustedSqmPrice: number;
  squareMeters: number | null;
  salePrice: number | null;
  addressUrl: string | null;
  source: string | null;
  lng: number;
  lat: number;
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
      const [lng, lat] = (f.geometry as any)?.coordinates ?? [null, null];
      if (typeof lng !== "number" || typeof lat !== "number") return null;
      return {
        address: (p.tooltip_address ?? p.address ?? "").toString(),
        year: Number(p.year),
        adjustedSqmPrice: price,
        squareMeters: typeof p.square_meters === "number" ? p.square_meters : null,
        salePrice: typeof p.latest_sale_price === "number" ? p.latest_sale_price : null,
        addressUrl: typeof p.address_url === "string" ? p.address_url : null,
        source: typeof p.source === "string" ? p.source : null,
        lng,
        lat,
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

function boligsidenUrl(addressUrl: string | null, source: string | null): string | null {
  // Only new (boligsiden-sourced) rows have a real per-address slug; legacy rows'
  // address_url is a stale postal-area slug from the old scraper and doesn't
  // resolve to the actual sale's address page.
  if (source !== "boligsiden" || !addressUrl) return null;
  return `https://www.boligsiden.dk/adresse/${addressUrl}`;
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
            <rect x={x} y={y} width={Math.max(barW, 1)} height={barH} fill="var(--accent)" opacity={0.85} />
            {count > 0 && (
              <text x={x + barW / 2} y={y - 3} fontSize={9} textAnchor="middle" fill="var(--text-muted)">
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
        stroke="var(--border)"
      />
      <text x={padding.left} y={height - 6} fontSize={10} fill="var(--text-muted)">
        {fmt(min)}
      </text>
      <text x={width - padding.right} y={height - 6} fontSize={10} fill="var(--text-muted)" textAnchor="end">
        {fmt(max)}
      </text>
    </svg>
  );
}

const DEFAULT_PALETTE: PaletteName = "Viridis";

export default function SearchPage({ theme }: { theme: Theme }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ lng: number; lat: number } | null>(null);

  async function handleSearch() {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setHighlight(null);
    try {
      const r = await searchAddress(text);
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

    const layerList: any[] = [
      new ColumnLayer({
        id: "search-results",
        data: result.apartments.features,
        radius: 8,
        extruded: true,
        pickable: true,
        elevationScale: 250,
        getPosition: (f: any) => f.geometry.coordinates,
        getElevation: (f: any) => ((f.properties.adjusted_sqm_price ?? min) - min) / span,
        getFillColor: (f: any) =>
          colorForValue(((f.properties.adjusted_sqm_price ?? min) - min) / span, DEFAULT_PALETTE),
      }),
    ];

    if (highlight) {
      layerList.push(
        new ScatterplotLayer({
          id: "search-highlight",
          data: [highlight],
          getPosition: (d: any) => [d.lng, d.lat],
          radiusUnits: "meters",
          getRadius: 14,
          stroked: true,
          filled: true,
          getFillColor: [255, 210, 0, 130],
          getLineColor: [255, 255, 255, 230],
          lineWidthMinPixels: 3,
        })
      );
    }

    return layerList;
  }, [result, highlight]);

  const stats = useMemo(() => (result ? computeStats(result) : null), [result]);

  const viewState = useMemo(
    () => ({
      longitude: highlight?.lng ?? result?.lng ?? 12.56,
      latitude: highlight?.lat ?? result?.lat ?? 55.67,
      zoom: highlight ? 17 : result ? 15 : 10,
      pitch: 45,
    }),
    [highlight, result]
  );

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
            initialViewState={viewState}
            getTooltip={tooltip}
            theme={theme}
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
                    <th>Address</th>
                    <th>Year</th>
                    <th>Kr/m²</th>
                    <th>m²</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.rows.map((r, i) => {
                    const url = boligsidenUrl(r.addressUrl, r.source);
                    const isHighlighted = highlight && highlight.lng === r.lng && highlight.lat === r.lat;
                    return (
                      <tr key={i} className={isHighlighted ? "sales-row-highlighted" : undefined}>
                        <td>
                          <button
                            className="address-link"
                            onClick={() => setHighlight({ lng: r.lng, lat: r.lat })}
                            title="Highlight this sale on the map"
                          >
                            {r.address}
                          </button>
                        </td>
                        <td>{r.year}</td>
                        <td>{fmt(r.adjustedSqmPrice)}</td>
                        <td>{r.squareMeters != null ? fmt(r.squareMeters, 1) : "—"}</td>
                        <td>
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              Boligsiden
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
