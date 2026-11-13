export const fontProposal = {
  family: "Geist Sans",
  mono: "Geist Mono",
  source: "next/font/google, self-hosted at build time",
  fallback: "Segoe UI, Noto Sans, system-ui, sans-serif",
  reason:
    "Neutral grotesk with a high x-height, comfortable at 14px in dense product UI. Geist Mono is for invoice ids. Amounts stay in Geist Sans with tabular figures so the naira sign shares the text face.",
} as const;

export const typeScale = [
  { name: "Display", size: 36, line: 44, weight: 600, use: "Page title" },
  { name: "Title", size: 24, line: 32, weight: 600, use: "Section header" },
  { name: "Heading", size: 18, line: 28, weight: 600, use: "Card and dialog title" },
  { name: "Body", size: 16, line: 24, weight: 400, use: "Reading text" },
  { name: "UI", size: 14, line: 20, weight: 500, use: "Buttons, inputs, tables, navigation" },
  { name: "Caption", size: 12, line: 16, weight: 500, use: "Meta, badges, hints, errors" },
] as const;

export const spacingScale = [4, 8, 12, 16, 24, 32, 48, 64] as const;

export const radii = [
  { name: "Control", value: 8, use: "Buttons, inputs, menus" },
  { name: "Card", value: 12, use: "Cards, tables, panels" },
  { name: "Overlay", value: 16, use: "Dialogs and sheets" },
  { name: "Pill", value: 999, use: "Badges" },
] as const;

export const shadows = [
  {
    name: "xs",
    value: "0 1px 1px rgb(16 24 20 / 0.05)",
    use: "Hairline lift",
  },
  {
    name: "sm",
    value: "0 1px 2px rgb(16 24 20 / 0.06), 0 1px 1px rgb(16 24 20 / 0.04)",
    use: "Cards",
  },
  {
    name: "md",
    value: "0 8px 24px rgb(16 24 20 / 0.08)",
    use: "Popovers",
  },
  {
    name: "lg",
    value: "0 24px 48px rgb(16 24 20 / 0.16)",
    use: "Dialogs",
  },
] as const;
