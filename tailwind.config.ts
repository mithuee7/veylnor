import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#0A0A0C",
        panel: "#131316",
        panelBorder: "#232327",
        gold: "#C9A24B",
        goldSoft: "#E4CD8F",
        ink: "#F3F1EC",
        muted: "#8B8A8C",
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        body: ["var(--font-body)", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
