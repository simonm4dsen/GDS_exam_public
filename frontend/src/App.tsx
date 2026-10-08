import SearchPage from "./SearchPage";
import { useTheme } from "./useTheme";
import "./App.css";

export default function App() {
  const [theme, setTheme] = useTheme();

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Copenhagen Housing</h1>
        <nav>
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
      <main className="app-main">
        <SearchPage theme={theme} />
      </main>
    </div>
  );
}
