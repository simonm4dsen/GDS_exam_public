import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

function systemTheme(): Theme {
  // Default is light; only switch to dark if the browser explicitly
  // reports a dark preference.
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | null {
  const v = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
  return v === "light" || v === "dark" ? v : null;
}

/**
 * Tracks the active theme. Defaults to the browser's preferred
 * color scheme (light unless the OS/browser asks for dark), but a user
 * can override it via `setTheme`, which persists the choice so it sticks
 * across reloads even if the system preference changes later.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (storedTheme()) return; // user has an explicit override, ignore system changes
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setThemeState(systemTheme());
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  return [theme, setTheme];
}
