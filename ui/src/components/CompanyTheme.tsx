"use client";

import { useEffect } from "react";
import { useCompany } from "../context/CompanyContext";

/**
 * Injects company-specific theme accent colors as CSS custom properties.
 * Companies can pick a primary accent color that matches their brand.
 * The color is applied to --primary and related variables.
 */

// Preset accent palettes — each maps a hex color to OKLch values for light and dark themes.
const ACCENT_PRESETS: Record<string, { light: string; dark: string; ring: string }> = {
  // Blue (default)
  "#3b82f6": { light: "oklch(0.546 0.245 262.881)", dark: "oklch(0.623 0.214 259.815)", ring: "oklch(0.546 0.245 262.881)" },
  // Indigo
  "#6366f1": { light: "oklch(0.511 0.262 276.966)", dark: "oklch(0.585 0.233 277.117)", ring: "oklch(0.511 0.262 276.966)" },
  // Violet
  "#8b5cf6": { light: "oklch(0.541 0.281 293.009)", dark: "oklch(0.614 0.25 293.071)", ring: "oklch(0.541 0.281 293.009)" },
  // Emerald
  "#10b981": { light: "oklch(0.596 0.145 163.225)", dark: "oklch(0.648 0.15 163.225)", ring: "oklch(0.596 0.145 163.225)" },
  // Teal
  "#14b8a6": { light: "oklch(0.627 0.131 175.001)", dark: "oklch(0.679 0.135 175.001)", ring: "oklch(0.627 0.131 175.001)" },
  // Orange
  "#f97316": { light: "oklch(0.646 0.222 41.116)", dark: "oklch(0.696 0.202 41.116)", ring: "oklch(0.646 0.222 41.116)" },
  // Rose
  "#f43f5e": { light: "oklch(0.577 0.245 27.325)", dark: "oklch(0.637 0.237 25.331)", ring: "oklch(0.577 0.245 27.325)" },
  // Amber
  "#f59e0b": { light: "oklch(0.728 0.17 75.834)", dark: "oklch(0.778 0.17 75.834)", ring: "oklch(0.728 0.17 75.834)" },
  // Cyan
  "#06b6d4": { light: "oklch(0.609 0.126 221.723)", dark: "oklch(0.659 0.126 221.723)", ring: "oklch(0.609 0.126 221.723)" },
};

function applyAccentColor(hex: string | null | undefined) {
  const root = document.documentElement;
  if (!hex || !ACCENT_PRESETS[hex]) {
    // Reset to default (monochrome)
    root.style.removeProperty("--primary-accent");
    root.style.removeProperty("--ring-accent");
    root.style.removeProperty("--sidebar-primary-accent");
    return;
  }
  const preset = ACCENT_PRESETS[hex];
  const isDark = root.classList.contains("dark");
  const value = isDark ? preset.dark : preset.light;

  // Override primary with the accent color
  root.style.setProperty("--primary-accent", value);
  root.style.setProperty("--ring-accent", preset.ring);
  root.style.setProperty("--sidebar-primary-accent", value);
}

export default function CompanyTheme() {
  const { selectedCompany } = useCompany();
  const accentColor = (selectedCompany as any)?.themeAccentColor ?? null;

  useEffect(() => {
    applyAccentColor(accentColor);
    return () => {
      // Cleanup on unmount
      applyAccentColor(null);
    };
  }, [accentColor]);

  return null;
}

export { ACCENT_PRESETS };
