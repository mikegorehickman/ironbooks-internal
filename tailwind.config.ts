import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Ironbooks design language (2026-07 refresh). Exact values from the
        // approved mockup — do not invent new colors; compose from these.
        teal: {
          DEFAULT: "#3E908D", // brand accent, progress fills, health dots
          dark: "#2A6E6B",    // teal-text: links, approve buttons (AA on white)
          light: "#EDF5F4",   // teal pill tint
          lighter: "#F4F9F8", // ultra-light hover wash
          border: "#C9DEDC",  // teal pill border
        },
        navy: {
          DEFAULT: "#152F46", // navy-ink: primary text, headings, primary buttons
          deep: "#0B1D2E",    // button hover, loading screen bg
          light: "#1E3D5C",   // rail (sidebar) — same as `rail`
        },
        rail: "#1E3D5C",      // sidebar background (steel navy)
        gold: {
          DEFAULT: "#DAB461", // badges, "needs a human" accents
          deep: "#B08D45",    // eyebrows, darker gold text
          tint: "#FBF6EE",    // gold pill bg
          border: "#EAD9C4",  // gold pill border
        },
        rust: {
          DEFAULT: "#954E44", // alerts, past-due, failed (never pure red)
          tint: "#FAF1EF",    // rust pill bg
          border: "#E8CFC9",  // rust pill border
        },
        canvas: "#F5F7F9",    // page background
        hairline: "#EDF0F2",  // row dividers inside cards
        cardline: "#CBD4DC",  // card borders
        rule: "#E7EBEE",      // section rules
        ink: {
          DEFAULT: "#33424F", // body text
          slate: "#5B6672",   // secondary text
          light: "#8A96A1",   // muted text
        },
        pillgrey: { tint: "#F2F4F6", border: "#D4DAE0" },
      },
      boxShadow: {
        card: "0 1px 3px rgba(21,47,70,0.08)",
      },
      fontFamily: {
        sans: ["Figtree", "system-ui", "sans-serif"],
        brand: ["Oswald", "Figtree", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
