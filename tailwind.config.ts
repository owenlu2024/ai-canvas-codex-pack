import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#F8FAFC",
        panel: "#FFFFFF",
        line: "#E6E9F0",
        primary: "#111827",
        secondary: "#8A94A6",
        selected: "#6C63FF",
        imagePort: "#2ECC71",
        textPort: "#FFC928",
        edge: "#BFC6D4",
        danger: "#FF4D4F"
      },
      boxShadow: {
        soft: "0 8px 24px rgba(15, 23, 42, 0.08)",
        node: "0 4px 20px rgba(15, 23, 42, 0.06)",
        selected: "0 4px 18px rgba(15, 23, 42, 0.06), 0 0 0 2px rgba(108, 99, 255, 0.18)"
      },
      fontFamily: {
        sans: ["Inter", "PingFang SC", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
