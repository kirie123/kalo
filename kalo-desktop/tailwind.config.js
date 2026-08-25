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
        // Lifted surface: composer card, first-screen entry cards. Sits *above*
        // --bg (white on white in light mode, held apart by border + shadow).
        elevated: "var(--bg-elevated)",
        edge: "var(--border)",
        ink: "var(--text)",
        dim: "var(--text-dim)",
        accent: "var(--accent)",
        // Accent hues, icons only — never body text or primary buttons. Each
        // tone has a stroke color and a `-soft` backplate (see index.css).
        tone: {
          blue: "var(--tone-blue)",
          "blue-soft": "var(--tone-blue-soft)",
          green: "var(--tone-green)",
          "green-soft": "var(--tone-green-soft)",
          orange: "var(--tone-orange)",
          "orange-soft": "var(--tone-orange-soft)",
          violet: "var(--tone-violet)",
          "violet-soft": "var(--tone-violet-soft)",
          pink: "var(--tone-pink)",
          "pink-soft": "var(--tone-pink-soft)",
        },
      },
      // The whole scale is bumped one step (see doc/2026-08-25-界面风格改版.md):
      // every existing `rounded-*` usage inherits the softer look for free.
      // `rounded-full` is untouched, so avatars and the send button stay round.
      borderRadius: {
        DEFAULT: "6px",
        md: "8px",
        lg: "12px",
        xl: "16px",
        "2xl": "20px",
      },
      boxShadow: {
        // Soft, wide, low-opacity — the reference style's "floating card".
        // NB: don't name these after a color key above (`card`, `elevated`, …).
        // Tailwind also derives `shadow-<color>` utilities from the palette, and
        // the color rule is emitted later, so it would silently win.
        soft: "0 1px 2px rgba(0, 0, 0, 0.03), 0 6px 20px rgba(0, 0, 0, 0.05)",
        lift: "0 2px 4px rgba(0, 0, 0, 0.04), 0 10px 28px rgba(0, 0, 0, 0.07)",
      },
    },
  },
  plugins: [],
};
