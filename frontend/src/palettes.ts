// Simple perceptually-reasonable sequential color palettes (RGB, 0-255),
// used in place of the Streamlit app's leafmap.colormaps dependency.

export type PaletteName = "Viridis" | "Plasma" | "Inferno" | "Blues" | "OrRd";

const STOPS: Record<PaletteName, [number, number, number][]> = {
  Viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  Plasma: [
    [13, 8, 135],
    [126, 3, 168],
    [204, 71, 120],
    [248, 149, 64],
    [240, 249, 33],
  ],
  Inferno: [
    [0, 0, 4],
    [87, 16, 110],
    [188, 55, 84],
    [249, 142, 9],
    [252, 255, 164],
  ],
  Blues: [
    [247, 251, 255],
    [198, 219, 239],
    [107, 174, 214],
    [33, 113, 181],
    [8, 48, 107],
  ],
  OrRd: [
    [255, 247, 236],
    [253, 212, 158],
    [253, 141, 60],
    [217, 71, 1],
    [127, 0, 0],
  ],
};

export const PALETTE_NAMES = Object.keys(STOPS) as PaletteName[];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Returns an RGB color for t in [0, 1] by interpolating along the palette stops. */
export function colorForValue(t: number, palette: PaletteName): [number, number, number] {
  const stops = STOPS[palette];
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  return [
    Math.round(lerp(a[0], b[0], frac)),
    Math.round(lerp(a[1], b[1], frac)),
    Math.round(lerp(a[2], b[2], frac)),
  ];
}

export function gradientCss(palette: PaletteName): string {
  const stops = STOPS[palette];
  const parts = stops.map((c, i) => `rgb(${c[0]},${c[1]},${c[2]}) ${(i / (stops.length - 1)) * 100}%`);
  return `linear-gradient(to top, ${parts.join(", ")})`;
}
