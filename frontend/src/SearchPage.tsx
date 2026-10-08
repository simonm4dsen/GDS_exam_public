import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import MapView from "./MapView";
import { fetchAllMapPoints, searchAddress, type AllMapData, type SearchResult } from "./api";
import type { Theme } from "./useTheme";

interface SaleRow {
  address: string;
  year: number;
  adjustedSqmPrice: number;
  normalizedSqmPrice: number;
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

interface AddressMapPoint {
  lng: number;
  lat: number;
  address: string;
  averageNormalizedPrice: number;
  sales: { year: number; normalizedSqmPrice: number }[];
}

interface NormalizedPriceScale {
  min: number;
  max: number;
  p33: number;
  p67: number;
  domainMin: number;
  domainMax: number;
}

const PRICE_GRADIENT: [number, number, number][] = [
  [46, 204, 113],
  [241, 196, 15],
  [243, 156, 18],
  [231, 76, 60],
];

function normalizedPriceScale(sortedPrices: number[]): NormalizedPriceScale {
  const min = sortedPrices[0];
  const max = sortedPrices[sortedPrices.length - 1];
  const pad = (max - min || 1) * 0.08;
  return {
    min,
    max,
    p33: quantile(sortedPrices, 1 / 3),
    p67: quantile(sortedPrices, 2 / 3),
    domainMin: min - pad,
    domainMax: max + pad,
  };
}

function colorForNormalizedPrice(price: number, scale: NormalizedPriceScale): [number, number, number] {
  const stops = [scale.domainMin, scale.p33, scale.p67, scale.domainMax];
  for (let segment = 0; segment < stops.length - 1; segment++) {
    const span = stops[segment + 1] - stops[segment];
    if (span > 0 && price <= stops[segment + 1]) {
      const t = Math.max(0, Math.min(1, (price - stops[segment]) / span));
      const start = PRICE_GRADIENT[segment];
      const end = PRICE_GRADIENT[segment + 1];
      return start.map((channel, i) => Math.round(channel + (end[i] - channel) * t)) as [number, number, number];
    }
  }
  return PRICE_GRADIENT[PRICE_GRADIENT.length - 1];
}

function buildAddressPoints(rows: SaleRow[]): AddressMapPoint[] {
  const grouped = new Map<string, AddressMapPoint>();
  for (const sale of rows) {
    const key = `${sale.lat.toFixed(6)},${sale.lng.toFixed(6)}`;
    let point = grouped.get(key);
    if (!point) {
      point = { lng: sale.lng, lat: sale.lat, address: sale.address, averageNormalizedPrice: 0, sales: [] };
      grouped.set(key, point);
    }
    point.sales.push({ year: sale.year, normalizedSqmPrice: sale.normalizedSqmPrice });
  }
  return Array.from(grouped.values(), (point) => ({
    ...point,
    averageNormalizedPrice:
      point.sales.reduce((sum, sale) => sum + sale.normalizedSqmPrice, 0) / point.sales.length,
  }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character];
  });
}

function computeStats(result: SearchResult): SaleStats | null {
  const rows: SaleRow[] = result.apartments.features
    .map((f) => {
      const p = f.properties as any;
      const price = p.adjusted_sqm_price;
      if (typeof price !== "number" || Number.isNaN(price)) return null;
      const normalizedPrice = typeof p.normalized_sqm_price === "number" ? p.normalized_sqm_price : price;
      const [lng, lat] = (f.geometry as any)?.coordinates ?? [null, null];
      if (typeof lng !== "number" || typeof lat !== "number") return null;
      return {
        address: (p.tooltip_address ?? p.address ?? "").toString(),
        year: Number(p.year),
        adjustedSqmPrice: price,
        normalizedSqmPrice: normalizedPrice,
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

function quantile(sortedValues: number[], q: number): number {
  const n = sortedValues.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedValues[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

/**
 * Gaussian kernel density estimate, sampled on an evenly spaced grid across
 * (a slightly padded) price domain. Bandwidth via Silverman's rule of thumb.
 */
function kernelDensity(sortedPrices: number[], gridN = 200) {
  const n = sortedPrices.length;
  const scale = normalizedPriceScale(sortedPrices);
  const dataMin = scale.min;
  const dataMax = scale.max;
  const span = dataMax - dataMin || 1;
  const { domainMin, domainMax } = scale;

  const mean = sortedPrices.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? sortedPrices.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const iqr = quantile(sortedPrices, 0.75) - quantile(sortedPrices, 0.25);
  const sigmaEst = iqr > 0 ? Math.min(std, iqr / 1.34) : std;
  const bandwidth = Math.max(0.9 * (sigmaEst || span) * Math.pow(n, -0.2), span / gridN);

  const gridStep = (domainMax - domainMin) / gridN;
  const grid: number[] = [];
  const density: number[] = [];
  const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
  for (let j = 0; j <= gridN; j++) {
    const x = domainMin + j * gridStep;
    let sum = 0;
    for (const xi of sortedPrices) {
      const u = (x - xi) / bandwidth;
      sum += Math.exp(-0.5 * u * u);
    }
    grid.push(x);
    density.push(sum * norm);
  }
  return { domainMin, domainMax, gridStep, grid, density, maxDensity: Math.max(...density, 1e-9) };
}

function PriceDistribution({ prices }: { prices: number[] }) {
  const width = 600;
  const densityHeight = 172;
  const gaugeHeight = 34;
  const gaugeGap = 16;
  const padding = { top: 34, right: 10, bottom: 24, left: 36 };
  const [hoverX, setHoverX] = useState<number | null>(null);

  const sorted = [...prices].sort((a, b) => a - b);
  const { domainMin, domainMax, gridStep, grid, density, maxDensity } = kernelDensity(sorted);
  const { p33, p67 } = normalizedPriceScale(sorted);
  const percentiles = [
    { label: "25th", price: quantile(sorted, 0.25) },
    { label: "Median", price: quantile(sorted, 0.5) },
    { label: "75th", price: quantile(sorted, 0.75) },
  ];

  const innerW = width - padding.left - padding.right;
  const innerH = densityHeight - padding.top - padding.bottom;

  const xScale = (price: number) => padding.left + ((price - domainMin) / (domainMax - domainMin)) * innerW;
  const yScale = (d: number) => padding.top + innerH - (d / maxDensity) * innerH;

  const linePath = grid.map((x, j) => `${j === 0 ? "M" : "L"}${xScale(x)},${yScale(density[j])}`).join(" ");
  const areaPath = `${linePath} L${xScale(domainMax)},${padding.top + innerH} L${xScale(domainMin)},${
    padding.top + innerH
  } Z`;

  const gaugeY = densityHeight + gaugeGap;
  const gaugeInnerH = gaugeHeight - 16;

  function priceAtClientX(clientX: number, svgEl: SVGSVGElement): number {
    const rect = svgEl.getBoundingClientRect();
    const scaleX = width / rect.width; // account for CSS scaling of the SVG
    const px = (clientX - rect.left) * scaleX;
    const clamped = Math.min(Math.max(px, padding.left), width - padding.right);
    return domainMin + ((clamped - padding.left) / innerW) * (domainMax - domainMin);
  }

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const price = priceAtClientX(e.clientX, e.currentTarget);
    setHoverX(xScale(price));
  }

  const hoverPrice = hoverX != null ? domainMin + ((hoverX - padding.left) / innerW) * (domainMax - domainMin) : null;
  const hoverDensity =
    hoverPrice != null ? density[Math.min(grid.length - 1, Math.max(0, Math.round((hoverPrice - domainMin) / gridStep)))] : null;
  const labelX = hoverX != null ? Math.min(Math.max(hoverX, padding.left + 40), width - padding.right - 40) : 0;

  return (
    <svg
      width={width}
      height={gaugeY + gaugeHeight + 12}
      viewBox={`0 0 ${width} ${gaugeY + gaugeHeight + 12}`}
      role="img"
      aria-label="Price density distribution and cheap/expected/high price gauge"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverX(null)}
      style={{ cursor: "crosshair", display: "block", width: "100%", maxWidth: "100%" }}
    >
      {/* density curve */}
      <path d={areaPath} fill="var(--accent)" opacity={0.25} />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {percentiles.map(({ label, price }) => {
        const x = xScale(price);
        return (
          <g key={label} aria-label={`${label} percentile: ${fmt(price)} kr/m²`}>
            <line
              x1={x}
              y1={padding.top - 2}
              x2={x}
              y2={padding.top + innerH}
              className="percentile-guide"
            />
            <text
              x={x}
              y={padding.top - 16}
              fontSize={10}
              className="percentile-value"
              textAnchor="middle"
              paintOrder="stroke"
              stroke="var(--bg-elevated)"
              strokeWidth={3}
              strokeLinejoin="round"
            >
              {fmt(price)}
            </text>
            <text x={x} y={padding.top - 4} fontSize={8} className="percentile-label" textAnchor="middle">
              {label}
            </text>
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
      <text x={padding.left} y={densityHeight - 6} fontSize={10} fill="var(--text-muted)">
        {fmt(domainMin)}
      </text>
      <text x={width - padding.right} y={densityHeight - 6} fontSize={10} fill="var(--text-muted)" textAnchor="end">
        {fmt(domainMax)}
      </text>

      {/* price gauge: cheap / expected / high segments, sharing the x axis above */}
      <defs>
        <linearGradient id="normalized-price-gradient">
          {[domainMin, p33, p67, domainMax].map((price, i) => (
            <stop
              key={i}
              offset={`${((price - domainMin) / (domainMax - domainMin)) * 100}%`}
              stopColor={`rgb(${PRICE_GRADIENT[i].join(",")})`}
            />
          ))}
        </linearGradient>
      </defs>
      <rect
        x={xScale(domainMin)}
        y={gaugeY}
        width={xScale(domainMax) - xScale(domainMin)}
        height={gaugeInnerH}
        fill="url(#normalized-price-gradient)"
      />
      <text x={xScale(domainMin)} y={gaugeY + gaugeInnerH + 12} fontSize={9} fill="var(--text-muted)">
        Cheap
      </text>
      <text
        x={(xScale(p33) + xScale(p67)) / 2}
        y={gaugeY + gaugeInnerH + 12}
        fontSize={9}
        fill="var(--text-muted)"
        textAnchor="middle"
      >
        Expected
      </text>
      <text x={xScale(domainMax)} y={gaugeY + gaugeInnerH + 12} fontSize={9} fill="var(--text-muted)" textAnchor="end">
        High
      </text>

      {/* hover crosshair + tooltip, spanning both charts */}
      {hoverX != null && hoverPrice != null && (
        <>
          <line
            x1={hoverX}
            y1={padding.top}
            x2={hoverX}
            y2={padding.top + innerH}
            className="distribution-hover-guide"
          />
          <circle cx={hoverX} cy={yScale(hoverDensity ?? 0)} r={3} fill="var(--accent)" />
          <line
            x1={hoverX}
            y1={gaugeY}
            x2={hoverX}
            y2={gaugeY + gaugeInnerH}
            className="distribution-hover-guide"
          />
          <g transform={`translate(${labelX}, ${padding.top + 4})`}>
            <rect x={-40} y={-2} width={80} height={16} rx={3} fill="var(--bg-elevated)" stroke="var(--border)" />
            <text x={0} y={10} fontSize={10} fill="var(--text)" textAnchor="middle">
              {fmt(hoverPrice)} kr/m²
            </text>
          </g>
        </>
      )}
    </svg>
  );
}

interface YearlyPoint {
  year: number;
  mean: number;
  std: number;
  count: number;
}

function computeYearlyStats(rows: SaleRow[]): YearlyPoint[] {
  const byYear = new Map<number, number[]>();
  for (const r of rows) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year)!.push(r.adjustedSqmPrice);
  }
  return Array.from(byYear.entries())
    .map(([year, prices]) => {
      const n = prices.length;
      const mean = prices.reduce((a, b) => a + b, 0) / n;
      const variance = n > 1 ? prices.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
      return { year, mean, std: Math.sqrt(variance), count: n };
    })
    .sort((a, b) => a.year - b.year);
}

function PriceDevelopment({ rows }: { rows: SaleRow[] }) {
  const width = 600;
  const height = 190;
  const padding = { top: 10, right: 10, bottom: 24, left: 46 };
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const points = computeYearlyStats(rows);
  if (points.length === 0) return null;

  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const minYear = points[0].year;
  const maxYear = points[points.length - 1].year;
  const yearSpan = maxYear - minYear || 1;

  const yMin = Math.min(...points.map((p) => p.mean - p.std));
  const yMax = Math.max(...points.map((p) => p.mean + p.std));
  const yPad = (yMax - yMin || 1) * 0.08;
  const domainMin = yMin - yPad;
  const domainMax = yMax + yPad;

  const xScale = (year: number) => padding.left + ((year - minYear) / yearSpan) * innerW;
  const yScale = (v: number) => padding.top + innerH - ((v - domainMin) / (domainMax - domainMin)) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.year)},${yScale(p.mean)}`).join(" ");
  const upperPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.year)},${yScale(p.mean + p.std)}`).join(" ");
  const lowerPath = [...points]
    .reverse()
    .map((p) => `L${xScale(p.year)},${yScale(p.mean - p.std)}`)
    .join(" ");
  const bandPath = `${upperPath} ${lowerPath} Z`;

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = width / rect.width;
    const px = (e.clientX - rect.left) * scaleX;
    let nearest = 0;
    let best = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(xScale(p.year) - px);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  }

  const hovered = hoverIdx != null ? points[hoverIdx] : null;
  const labelX = hovered ? Math.min(Math.max(xScale(hovered.year), padding.left + 50), width - padding.right - 50) : 0;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Mean adjusted price per year with standard deviation band"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverIdx(null)}
      style={{ cursor: "crosshair", display: "block", width: "100%", maxWidth: "100%" }}
    >
      <path d={bandPath} fill="var(--accent)" opacity={0.15} />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={i} cx={xScale(p.year)} cy={yScale(p.mean)} r={2.5} fill="var(--accent)" />
      ))}

      <line
        x1={padding.left}
        y1={padding.top + innerH}
        x2={width - padding.right}
        y2={padding.top + innerH}
        stroke="var(--border)"
      />
      <text x={padding.left} y={height - 6} fontSize={10} fill="var(--text-muted)">
        {minYear}
      </text>
      <text x={width - padding.right} y={height - 6} fontSize={10} fill="var(--text-muted)" textAnchor="end">
        {maxYear}
      </text>
      <text x={padding.left - 6} y={yScale(domainMax) + 4} fontSize={10} fill="var(--text-muted)" textAnchor="end">
        {fmt(domainMax)}
      </text>
      <text x={padding.left - 6} y={yScale(domainMin) + 4} fontSize={10} fill="var(--text-muted)" textAnchor="end">
        {fmt(domainMin)}
      </text>

      {hovered && (
        <>
          <line
            x1={xScale(hovered.year)}
            y1={padding.top}
            x2={xScale(hovered.year)}
            y2={padding.top + innerH}
            stroke="var(--text)"
            strokeDasharray="3,3"
            opacity={0.6}
          />
          <circle cx={xScale(hovered.year)} cy={yScale(hovered.mean)} r={4} fill="var(--accent)" stroke="var(--bg-elevated)" strokeWidth={1.5} />
          <g transform={`translate(${labelX}, ${padding.top + 4})`}>
            <rect x={-55} y={-2} width={110} height={40} rx={3} fill="var(--bg-elevated)" stroke="var(--border)" />
            <text x={0} y={10} fontSize={10} fill="var(--text)" textAnchor="middle">
              {hovered.year}: {fmt(hovered.mean)} kr/m²
            </text>
            <text x={0} y={22} fontSize={9} fill="var(--text-muted)" textAnchor="middle">
              ±{fmt(hovered.std)} ({hovered.count} sales)
            </text>
          </g>
        </>
      )}
    </svg>
  );
}

export default function SearchPage({ theme }: { theme: Theme }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"all" | "search">("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [allData, setAllData] = useState<AllMapData | null>(null);
  const allDataRef = useRef<AllMapData | null>(null);
  const allRequestRef = useRef<Promise<AllMapData | null> | null>(null);
  const [loading, setLoading] = useState(false);
  const [allLoading, setAllLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ lng: number; lat: number } | null>(null);

  const ensureAllData = useCallback((): Promise<AllMapData | null> => {
    if (allDataRef.current) return Promise.resolve(allDataRef.current);
    if (allRequestRef.current) return allRequestRef.current;

    setAllLoading(true);
    setError(null);
    const request = fetchAllMapPoints()
      .then((data) => {
        allDataRef.current = data;
        setAllData(data);
        return data;
      })
      .catch((e: unknown) => {
        setError(String(e instanceof Error ? e.message : e));
        return null;
      })
      .finally(() => {
        allRequestRef.current = null;
        setAllLoading(false);
      });
    allRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    void ensureAllData();
  }, [ensureAllData]);

  async function handleSearch() {
    if (!text.trim()) return;
    setMode("search");
    setLoading(true);
    setError(null);
    setHighlight(null);
    setResult(null);
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

  function handleShowAll() {
    setMode("all");
    setResult(null);
    setHighlight(null);
    void ensureAllData();
  }

  const stats = useMemo(() => (result ? computeStats(result) : null), [result]);
  const mapPoints = useMemo<AddressMapPoint[]>(() => {
    if (mode === "all") {
      return (allData?.points ?? []).map((point) => ({
        ...point,
        sales: point.sales.map((sale) => ({
          year: sale.year,
          normalizedSqmPrice: sale.normalizedSqmPrice,
        })),
      }));
    }
    return stats ? buildAddressPoints(stats.rows) : [];
  }, [mode, allData, stats]);
  const priceScale = useMemo(() => {
    if (mode === "all" && allData) {
      const scale = allData.price_scale;
      return {
        ...scale,
        domainMin: scale.domain_min,
        domainMax: scale.domain_max,
      };
    }
    if (!stats) return null;
    return normalizedPriceScale(stats.rows.map((row) => row.normalizedSqmPrice).sort((a, b) => a - b));
  }, [mode, allData, stats]);

  const layers = useMemo(() => {
    if ((mode === "all" && !allData) || (mode === "search" && !result) || !priceScale) return [];
    const layerList: any[] = [
      new ScatterplotLayer({
        id: "search-results",
        data: mapPoints,
        radiusUnits: "pixels",
        getRadius: 4,
        radiusMinPixels: 3,
        radiusMaxPixels: 6,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 210],
        stroked: true,
        lineWidthMinPixels: 1,
        getPosition: (point: AddressMapPoint) => [point.lng, point.lat],
        getFillColor: (point: AddressMapPoint) => [...colorForNormalizedPrice(point.averageNormalizedPrice, priceScale), 225],
        getLineColor: [255, 255, 255, 150],
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
  }, [mode, result, allData, mapPoints, priceScale, highlight]);

  const viewState = useMemo(
    () => ({
      longitude: highlight?.lng ?? (mode === "all" ? 12.43 : result?.lng ?? 12.56),
      latitude: highlight?.lat ?? (mode === "all" ? 55.69 : result?.lat ?? 55.67),
      zoom: highlight ? 17 : mode === "all" ? 9 : result ? 15 : 10,
      pitch: 0,
      bearing: 0,
    }),
    [highlight, mode, result]
  );

  const tooltip = (info: any) => {
    if (info.object?.sales) {
      const point = info.object as AddressMapPoint;
      const sales = [...point.sales]
        .sort((a, b) => b.year - a.year || b.normalizedSqmPrice - a.normalizedSqmPrice)
        .map(
          (sale) =>
            `<li>${sale.year}: ${fmt(sale.normalizedSqmPrice)} kr/m²</li>`
        )
        .join("");
      return `<b>${escapeHtml(point.address || "Address")}</b><br/>Mean normalized price: ${fmt(
        point.averageNormalizedPrice
      )} kr/m²<br/><small>Sales (normalized to 2026):</small><ul style="margin:4px 0 0;padding-left:18px">${sales}</ul>`;
    }
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
        <button
          type="button"
          className={`all-mode-button${mode === "all" ? " active" : ""}`}
          onClick={handleShowAll}
          aria-pressed={mode === "all"}
          disabled={allLoading}
        >
          {allLoading ? "Loading…" : "All"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {mode === "all" && allData && (
        <div className="result-banner">
          Showing {fmt(allData.count)} address locations across {fmt(allData.sale_count)} sales
        </div>
      )}
      {result && (
        <div className="result-banner">
          Matched "{result.query}" to <b>{result.matched_address}</b> — {result.count} apartments on nearby addresses
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
        <div className="map-view-container" style={{ flex: 1, minWidth: 0 }}>
          <MapView
            layers={layers}
            initialViewState={viewState}
            getTooltip={tooltip}
            theme={theme}
          />
          {((mode === "all" && allLoading) || (mode === "search" && loading)) && (
            <div className="map-loading" role="status" aria-live="polite">
              {mode === "all" ? "Preparing all map points…" : "Searching nearby sales…"}
            </div>
          )}
        </div>

        {stats && (
          <div
            style={{
              width: "45%",
              maxWidth: 640,
              minWidth: 0,
              flex: "0 1 45%",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
              padding: "12px 16px",
              borderLeft: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text)",
            }}
          >
            <div className="sale-summary-content" style={{ flexShrink: 0 }}>
              <h3 className="summary-title">Sale summary</h3>
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

              <section className="insight-card">
                <div className="insight-card-heading">
                  <h4>Price distribution</h4>
                  <p className="stat-label">Normalized to 2026 price levels</p>
                </div>
                <div className="chart-container">
                  <PriceDistribution prices={stats.rows.map((r) => r.normalizedSqmPrice)} />
                </div>
              </section>

              <section className="insight-card">
                <div className="insight-card-heading">
                  <h4>Price development</h4>
                  <p className="stat-label">Actual prices at time of sale</p>
                </div>
                <div className="chart-container">
                  <PriceDevelopment rows={stats.rows} />
                </div>
              </section>

              <h4 className="sales-table-title">Sales by year</h4>
            </div>

            <div className="sales-table-container" style={{ flex: "1 1 240px", minHeight: 240, overflowY: "auto" }}>
              <table className="sales-table">
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Year</th>
                    <th>Kr/m²</th>
                    <th>Norm. kr/m²</th>
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
                        <td>{fmt(r.normalizedSqmPrice)}</td>
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
