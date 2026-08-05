import { useEffect, useMemo, useState } from "react";
import { ColumnLayer } from "@deck.gl/layers";
import { GeoJsonLayer } from "@deck.gl/layers";
import MapView from "./MapView";
import { fetchApartments, fetchMeta, fetchParishStats, fetchPostalStats, type Meta } from "./api";
import { colorForValue, gradientCss, PALETTE_NAMES, type PaletteName } from "./palettes";

type Scale = "apartments" | "postal" | "parish";
type Attribute = "adjusted_sqm_price" | "square_meters_price";

const COPENHAGEN_VIEW = { longitude: 12.56, latitude: 55.67, zoom: 10, pitch: 45, bearing: 0 };

function scaleValues<T extends Record<string, any>>(features: T[], key: string): (t: number) => number {
  const values = features.map((f) => f[key]).filter((v) => typeof v === "number" && !Number.isNaN(v));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return (v: number) => (v - min) / span;
}

export default function HomePage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [yearRange, setYearRange] = useState<[number, number]>([2020, 2024]);
  const [attribute, setAttribute] = useState<Attribute>("adjusted_sqm_price");
  const [scale, setScale] = useState<Scale>("apartments");
  const [palette, setPalette] = useState<PaletteName>("Viridis");
  const [layers, setLayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [minMax, setMinMax] = useState<[number, number]>([0, 1]);

  useEffect(() => {
    fetchMeta().then((m) => {
      setMeta(m);
      setYearRange([m.min_year, m.max_year]);
    });
  }, []);

  async function handlePlot() {
    setLoading(true);
    try {
      if (scale === "apartments") {
        const fc = await fetchApartments({ yearMin: yearRange[0], yearMax: yearRange[1], limit: 15000 });
        const props = fc.features.map((f) => f.properties as any);
        const norm = scaleValues(props, attribute);
        const values = props.map((p) => p[attribute]).filter((v) => typeof v === "number");
        setMinMax([Math.min(...values), Math.max(...values)]);

        const layer = new ColumnLayer({
          id: "apartments",
          data: fc.features,
          diskResolution: 6,
          radius: 45,
          extruded: true,
          pickable: true,
          elevationScale: 0.02,
          getPosition: (f: any) => f.geometry.coordinates,
          getElevation: (f: any) => f.properties[attribute] ?? 0,
          getFillColor: (f: any) => colorForValue(norm(f.properties[attribute] ?? 0), palette),
        });
        setLayers([layer]);
      } else if (scale === "postal") {
        const fc = await fetchPostalStats({ yearMin: yearRange[0], yearMax: yearRange[1] });
        const props = fc.features.map((f) => f.properties as any);
        const norm = scaleValues(props, "adjusted_sqm_price_median");
        const values = props.map((p) => p["adjusted_sqm_price_median"]).filter((v) => typeof v === "number");
        setMinMax([Math.min(...values), Math.max(...values)]);

        const layer = new GeoJsonLayer({
          id: "postal-stats",
          data: fc,
          filled: true,
          extruded: true,
          stroked: true,
          wireframe: true,
          pickable: true,
          opacity: 0.7,
          getElevation: (f: any) => f.properties.adjusted_sqm_price_median ?? 0,
          elevationScale: 0.15,
          getFillColor: (f: any) => colorForValue(norm(f.properties.adjusted_sqm_price_median ?? 0), palette),
          getLineColor: [0, 0, 0],
          lineWidthMinPixels: 1,
        });
        setLayers([layer]);
      } else {
        const fc = await fetchParishStats({ yearMin: yearRange[0], yearMax: yearRange[1] });
        const props = fc.features.map((f) => f.properties as any);
        const norm = scaleValues(props, "adjusted_sqm_price_median");
        const values = props.map((p) => p["adjusted_sqm_price_median"]).filter((v) => typeof v === "number");
        setMinMax([Math.min(...values), Math.max(...values)]);

        const layer = new GeoJsonLayer({
          id: "parish-stats",
          data: fc,
          filled: true,
          extruded: true,
          stroked: true,
          wireframe: true,
          pickable: true,
          opacity: 0.7,
          getElevation: (f: any) => f.properties.adjusted_sqm_price_median ?? 0,
          elevationScale: 0.15,
          getFillColor: (f: any) => colorForValue(norm(f.properties.adjusted_sqm_price_median ?? 0), palette),
          getLineColor: [0, 0, 0],
          lineWidthMinPixels: 1,
        });
        setLayers([layer]);
      }
    } catch (e) {
      console.error(e);
      alert(`Failed to load data: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  const tooltip = useMemo(
    () => (info: any) => {
      const p = info.object?.properties;
      if (!p) return null;
      if (scale === "apartments") {
        return `<b>${p.tooltip_address ?? p.address ?? ""}</b><br/>${p.tooltip_price ?? ""} kr/m²`;
      }
      const name = p.city ?? p.sognenavn ?? "";
      const price = p.adjusted_sqm_price_median ? Math.round(p.adjusted_sqm_price_median).toLocaleString() : "";
      return `<b>${name}</b><br/>${price} kr/m² (median)`;
    },
    [scale]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="controls">
        {meta && (
          <label>
            Data from {yearRange[0]}–{yearRange[1]}
            <input
              type="range"
              min={meta.min_year}
              max={meta.max_year}
              value={yearRange[0]}
              onChange={(e) => setYearRange([Number(e.target.value), yearRange[1]])}
            />
            <input
              type="range"
              min={meta.min_year}
              max={meta.max_year}
              value={yearRange[1]}
              onChange={(e) => setYearRange([yearRange[0], Number(e.target.value)])}
            />
          </label>
        )}

        <label>
          Attribute
          <select value={attribute} onChange={(e) => setAttribute(e.target.value as Attribute)}>
            <option value="adjusted_sqm_price">Adj. price m²</option>
            <option value="square_meters_price">Price m²</option>
          </select>
        </label>

        <label>
          Scale
          <select value={scale} onChange={(e) => setScale(e.target.value as Scale)}>
            <option value="apartments">Individual Apartments</option>
            <option value="postal">Postal Codes</option>
            <option value="parish">Parish (Sogn)</option>
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

        <button onClick={handlePlot} disabled={loading}>
          {loading ? "Loading…" : "Plot"}
        </button>
      </div>

      <div style={{ flex: 1, display: "flex" }}>
        <div style={{ flex: 1 }}>
          <MapView layers={layers} initialViewState={COPENHAGEN_VIEW} getTooltip={tooltip} />
        </div>
        <div className="colorbar">
          <div className="colorbar-gradient" style={{ background: gradientCss(palette) }} />
          <div className="colorbar-labels">
            <span>{Math.round(minMax[1]).toLocaleString()}</span>
            <span>{Math.round(minMax[0]).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
