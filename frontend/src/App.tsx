import { useState } from "react";
import HomePage from "./HomePage";
import SearchPage from "./SearchPage";
import { useTheme } from "./useTheme";
import "./App.css";

type Page = "home" | "search";

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [theme, setTheme] = useTheme();

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Copenhagen Housing</h1>
        <nav>
          <button className={page === "home" ? "active" : ""} onClick={() => setPage("home")}>
            Home
          </button>
          <button className={page === "search" ? "active" : ""} onClick={() => setPage("search")}>
            Search
          </button>
          <button
            className="theme-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            aria-label="Toggle color theme"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </nav>
      </header>
      <main className="app-main">{page === "home" ? <HomePage theme={theme} /> : <SearchPage theme={theme} />}</main>
    </div>
  );
}
