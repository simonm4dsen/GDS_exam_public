import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer } from "@deck.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Theme } from "./useTheme";

function basemapStyle(theme: Theme): any {
  const variant = theme === "dark" ? "dark_all" : "light_all";
  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: [
          `https://a.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}@2x.png`,
          `https://b.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}@2x.png`,
          `https://c.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}@2x.png`,
          `https://d.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}@2x.png`,
        ],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      },
    },
    layers: [{ id: "carto-raster", type: "raster", source: "carto" }],
  };
}

interface MapViewProps {
  layers: Layer[];
  initialViewState: { longitude: number; latitude: number; zoom: number; pitch?: number; bearing?: number };
  getTooltip?: (info: any) => string | null;
  theme?: Theme;
}

export default function MapView({ layers, initialViewState, getTooltip, theme = "light" }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle(theme),
      center: [initialViewState.longitude, initialViewState.latitude],
      zoom: initialViewState.zoom,
      pitch: initialViewState.pitch ?? 0,
      bearing: initialViewState.bearing ?? 0,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    const overlay = new MapboxOverlay({
      layers: [],
      getTooltip: (info: any) => {
        if (!info.object || !getTooltip) return null;
        const html = getTooltip(info);
        return html ? { html } : null;
      },
    });
    map.addControl(overlay as unknown as maplibregl.IControl);
    overlayRef.current = overlay;

    return () => {
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.setStyle(basemapStyle(theme));
  }, [theme]);

  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  useEffect(() => {
    mapRef.current?.flyTo({
      center: [initialViewState.longitude, initialViewState.latitude],
      zoom: initialViewState.zoom,
      essential: true,
    });
  }, [initialViewState.longitude, initialViewState.latitude, initialViewState.zoom]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <div ref={tooltipRef} />
    </div>
  );
}
