import { useState } from "react";
import HomePage from "./HomePage";
import SearchPage from "./SearchPage";
import "./App.css";

type Page = "home" | "search";

export default function App() {
  const [page, setPage] = useState<Page>("home");

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
        </nav>
      </header>
      <main className="app-main">{page === "home" ? <HomePage /> : <SearchPage />}</main>
    </div>
  );
}
