import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "../../packages/contracts/src/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        hull: "#05101b",
        steel: "#0f2334",
        glow: "#76f4ff",
        amber: "#f7b955",
        danger: "#ff5f7c",
        frost: "rgba(118, 244, 255, 0.08)"
      },
      boxShadow: {
        bridge: "0 0 0 1px rgba(118, 244, 255, 0.18), 0 0 40px rgba(10, 24, 40, 0.7)",
        pulse: "0 0 24px rgba(118, 244, 255, 0.25)"
      },
      backgroundImage: {
        grid: "linear-gradient(rgba(118,244,255,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(118,244,255,0.07) 1px, transparent 1px)"
      }
    }
  },
  plugins: []
};

export default config;

