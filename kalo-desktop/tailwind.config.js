/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        base: "var(--bg)",
        sidebar: "var(--bg-sidebar)",
        card: "var(--bg-card)",
        edge: "var(--border)",
        ink: "var(--text)",
        dim: "var(--text-dim)",
        accent: "var(--accent)",
      },
    },
  },
  plugins: [],
};
