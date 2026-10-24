import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./index.css";
import "./styles/skins.css";
import "./styles/desktop-shell.css";
import "./styles/notes.css";
import "./styles/files.css";
import "./styles/conversation.css";
import App from "./App";

/**
 * Silence the webview's own context menu outside editable fields
 * (doc/2026-08-27-右键菜单.md 「原生右键菜单全局抑制」).
 *
 * Its items — 返回/刷新/另存为/打印 on WebView2, Copy/Look Up on macOS — are
 * never what a right-click in this app is asking for, and they cover the app's
 * own menus. Editable fields keep it: paste and spell-check live there. Events
 * inside preview iframes never reach this document, so a rendered HTML page
 * keeps its own menu.
 */
function suppressNativeContextMenu() {
  window.addEventListener("contextmenu", (e) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    e.preventDefault();
  });
}

suppressNativeContextMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
