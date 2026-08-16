import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
