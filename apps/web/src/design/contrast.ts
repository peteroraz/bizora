/** WCAG 2.x contrast for sRGB colors written as #RRGGBB. */

export type ContrastKind = "text" | "large" | "ui";

export type ContrastPair = {
  label: string;
  foreground: string;
  background: string;
  kind: ContrastKind;
};

const HEX = /^#([\da-fA-F]{6})$/;

export function hexToRgb(hex: string): [number, number, number] {
  const match = HEX.exec(hex);
  if (!match) {
    throw new Error(`Expected #RRGGBB, received ${hex}`);
  }
  const value = match[1] ?? "";
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex);
  return (
    0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue)
  );
}

/** Contrast ratio in the range 1–21. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function minimumRatio(kind: ContrastKind): number {
  return kind === "text" ? 4.5 : 3;
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}
