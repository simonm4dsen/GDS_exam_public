export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8811";

export interface Meta {
  min_year: number;
  max_year: number;
  years: number[];
  postals: number[];
}

export async function fetchMeta(): Promise<Meta> {
  const r = await fetch(`${API_BASE}/api/meta`);
  if (!r.ok) throw new Error(`meta failed: ${r.status}`);
  return r.json();
}

export async function fetchApartments(params: {
  yearMin?: number;
  yearMax?: number;
  postal?: number;
  limit?: number;
}): Promise<GeoJSON.FeatureCollection> {
  const qs = new URLSearchParams();
  if (params.yearMin !== undefined) qs.set("year_min", String(params.yearMin));
  if (params.yearMax !== undefined) qs.set("year_max", String(params.yearMax));
  if (params.postal !== undefined) qs.set("postal", String(params.postal));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const r = await fetch(`${API_BASE}/api/apartments?${qs.toString()}`);
  if (!r.ok) throw new Error(`apartments failed: ${r.status}`);
  return r.json();
}

export interface MapPointSale {
  year: number;
  normalizedSqmPrice: number;
}

export interface MapPoint {
  lat: number;
  lng: number;
  address: string;
  averageNormalizedPrice: number;
  sales: MapPointSale[];
}

export interface AllMapData {
  count: number;
  sale_count: number;
  price_scale: {
    min: number;
    max: number;
    p33: number;
    p67: number;
    domain_min: number;
    domain_max: number;
  };
  points: MapPoint[];
}

export async function fetchAllMapPoints(): Promise<AllMapData> {
  const r = await fetch(`${API_BASE}/api/map-points`);
  if (!r.ok) throw new Error(`map points failed: ${r.status}`);
  return r.json();
}

export async function fetchPostalStats(params: {
  yearMin?: number;
  yearMax?: number;
}): Promise<GeoJSON.FeatureCollection> {
  const qs = new URLSearchParams();
  if (params.yearMin !== undefined) qs.set("year_min", String(params.yearMin));
  if (params.yearMax !== undefined) qs.set("year_max", String(params.yearMax));
  const r = await fetch(`${API_BASE}/api/postal-stats?${qs.toString()}`);
  if (!r.ok) throw new Error(`postal-stats failed: ${r.status}`);
  return r.json();
}

export async function fetchParishStats(params: {
  yearMin?: number;
  yearMax?: number;
}): Promise<GeoJSON.FeatureCollection> {
  const qs = new URLSearchParams();
  if (params.yearMin !== undefined) qs.set("year_min", String(params.yearMin));
  if (params.yearMax !== undefined) qs.set("year_max", String(params.yearMax));
  const r = await fetch(`${API_BASE}/api/parish-stats?${qs.toString()}`);
  if (!r.ok) throw new Error(`parish-stats failed: ${r.status}`);
  return r.json();
}

export interface SearchResult {
  query: string;
  matched_address: string | null;
  confidence: string | null;
  lat: number;
  lng: number;
  count: number;
  apartments: GeoJSON.FeatureCollection;
}

export async function searchAddress(address: string): Promise<SearchResult> {
  const qs = new URLSearchParams({ address });
  const r = await fetch(`${API_BASE}/api/search?${qs.toString()}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail ?? `search failed: ${r.status}`);
  }
  return r.json();
}
