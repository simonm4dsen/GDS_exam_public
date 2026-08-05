import { useMemo, useState } from "react";
import { ColumnLayer } from "@deck.gl/layers";
import MapView from "./MapView";
import { searchAddress, type SearchResult } from "./api";
import { colorForValue, type PaletteName, PALETTE_NAMES } from "./palettes";

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

      <div style={{ flex: 1 }}>
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
    </div>
  );
}
