import { type ContrastPair } from "./contrast";

export type PaletteMode = {
  id: "light" | "dark";
  canvas: string;
  card: string;
  fg: string;
  muted: string;
  border: string;
  primary: string;
  primaryFg: string;
  secondary: string;
  secondaryFg: string;
  input: string;
  dangerFg: string;
  dangerBorder: string;
  sidebar: string;
  sidebarFg: string;
  sidebarMuted: string;
  sidebarActive: string;
  sidebarActiveFg: string;
  sidebarAccent: string;
  tableHead: string;
  successBg: string;
  successFg: string;
  warningBg: string;
  warningFg: string;
  dangerBg: string;
  infoBg: string;
  infoFg: string;
  focus: string;
};

export type Palette = {
  id: "A" | "B" | "C";
  name: string;
  note: string;
  light: PaletteMode;
  dark: PaletteMode;
};

const lightStatus = {
  successBg: "#DCFAE6",
  successFg: "#085D3A",
  warningBg: "#FEF0C7",
  warningFg: "#93370D",
  dangerBg: "#FEE4E2",
  dangerFg: "#912018",
  dangerBorder: "#B42318",
  infoBg: "#D1E9FF",
  infoFg: "#1849A9",
} as const;

const darkStatus = {
  successBg: "#053321",
  successFg: "#ABEFC6",
  warningBg: "#4A1D09",
  warningFg: "#FDE68A",
  dangerBg: "#55160C",
  dangerFg: "#FECDCA",
  dangerBorder: "#FDA29B",
  infoBg: "#102A56",
  infoFg: "#B2DDFF",
} as const;

export const palettes: readonly Palette[] = [
  {
    id: "A",
    name: "Deep green",
    note: "Grove. A quiet ledger green. Closer to a private bank than a developer tool.",
    light: {
      id: "light",
      canvas: "#F4F6F4",
      card: "#FFFFFF",
      fg: "#122117",
      muted: "#3E5248",
      border: "#7C847E",
      primary: "#0B5F3C",
      primaryFg: "#F4FBF7",
      secondary: "#FFFFFF",
      secondaryFg: "#122117",
      input: "#FFFFFF",
      sidebar: "#E7EEE9",
      sidebarFg: "#122117",
      sidebarMuted: "#3E5248",
      sidebarActive: "#DDF3E8",
      sidebarActiveFg: "#064E32",
      sidebarAccent: "#0B5F3C",
      tableHead: "#E7EEE9",
      focus: "#0B5F3C",
      ...lightStatus,
    },
    dark: {
      id: "dark",
      canvas: "#0E1512",
      card: "#161E1A",
      fg: "#E8F0EB",
      muted: "#A8B8B0",
      border: "#748480",
      primary: "#3DDC97",
      primaryFg: "#052E1C",
      secondary: "#1C2622",
      secondaryFg: "#E8F0EB",
      input: "#161E1A",
      sidebar: "#161E1A",
      sidebarFg: "#E8F0EB",
      sidebarMuted: "#A8B8B0",
      sidebarActive: "#16382A",
      sidebarActiveFg: "#E8F0EB",
      sidebarAccent: "#3DDC97",
      tableHead: "#1C2622",
      focus: "#3DDC97",
      ...darkStatus,
    },
  },
  {
    id: "B",
    name: "Indigo",
    note: "Royal. The Linear and Stripe lane: cool, familiar software trust.",
    light: {
      id: "light",
      canvas: "#F5F6F8",
      card: "#FFFFFF",
      fg: "#161A2B",
      muted: "#3E4660",
      border: "#7E8694",
      primary: "#1E3A8A",
      primaryFg: "#F8FAFC",
      secondary: "#FFFFFF",
      secondaryFg: "#161A2B",
      input: "#FFFFFF",
      sidebar: "#E7ECF6",
      sidebarFg: "#161A2B",
      sidebarMuted: "#3E4660",
      sidebarActive: "#E0E9FB",
      sidebarActiveFg: "#1E3A8A",
      sidebarAccent: "#1E3A8A",
      tableHead: "#E7ECF6",
      focus: "#1E3A8A",
      ...lightStatus,
    },
    dark: {
      id: "dark",
      canvas: "#0D111C",
      card: "#161B28",
      fg: "#E8EAF2",
      muted: "#B4BDD2",
      border: "#7D879A",
      primary: "#A5B4FC",
      primaryFg: "#1E1B4B",
      secondary: "#222838",
      secondaryFg: "#E8EAF2",
      input: "#161B28",
      sidebar: "#161B28",
      sidebarFg: "#E8EAF2",
      sidebarMuted: "#B4BDD2",
      sidebarActive: "#1E1B4B",
      sidebarActiveFg: "#E8EAF2",
      sidebarAccent: "#A5B4FC",
      tableHead: "#222838",
      focus: "#A5B4FC",
      ...darkStatus,
    },
  },
  {
    id: "C",
    name: "Teal",
    note: "Harbor. Distinct from green and indigo, still calm. Slightly more coastal than ledger.",
    light: {
      id: "light",
      canvas: "#F3F7F6",
      card: "#FFFFFF",
      fg: "#102221",
      muted: "#3D5552",
      border: "#7A8884",
      primary: "#115E59",
      primaryFg: "#F0FDFA",
      secondary: "#FFFFFF",
      secondaryFg: "#102221",
      input: "#FFFFFF",
      sidebar: "#E5F2F0",
      sidebarFg: "#102221",
      sidebarMuted: "#3D5552",
      sidebarActive: "#D7F3EF",
      sidebarActiveFg: "#134E4A",
      sidebarAccent: "#115E59",
      tableHead: "#E5F2F0",
      focus: "#115E59",
      ...lightStatus,
    },
    dark: {
      id: "dark",
      canvas: "#0C1414",
      card: "#15201F",
      fg: "#E7F4F1",
      muted: "#A9C4BE",
      border: "#7E8E8A",
      primary: "#5EEAD4",
      primaryFg: "#042F2E",
      secondary: "#1C2928",
      secondaryFg: "#E7F4F1",
      input: "#15201F",
      sidebar: "#15201F",
      sidebarFg: "#E7F4F1",
      sidebarMuted: "#A9C4BE",
      sidebarActive: "#134E4A",
      sidebarActiveFg: "#E7F4F1",
      sidebarAccent: "#5EEAD4",
      tableHead: "#1C2928",
      focus: "#5EEAD4",
      ...darkStatus,
    },
  },
];

export const studio = {
  canvas: "#E6E8E3",
  panel: "#F7F8F6",
  fg: "#17211C",
  muted: "#3C4A43",
  border: "#6E7772",
} as const;

/** Every text, large-text, and UI pair drawn for one palette mode. */
export function contrastPairs(mode: PaletteMode): ContrastPair[] {
  return [
    { label: "Body text on canvas", foreground: mode.fg, background: mode.canvas, kind: "text" },
    { label: "Body text on card", foreground: mode.fg, background: mode.card, kind: "text" },
    { label: "Muted text on canvas", foreground: mode.muted, background: mode.canvas, kind: "text" },
    { label: "Muted text on card", foreground: mode.muted, background: mode.card, kind: "text" },
    {
      label: "Muted text on sidebar",
      foreground: mode.sidebarMuted,
      background: mode.sidebar,
      kind: "text",
    },
    {
      label: "Primary button label",
      foreground: mode.primaryFg,
      background: mode.primary,
      kind: "text",
    },
    {
      label: "Secondary button label",
      foreground: mode.secondaryFg,
      background: mode.secondary,
      kind: "text",
    },
    { label: "Input text", foreground: mode.fg, background: mode.input, kind: "text" },
    { label: "Error message", foreground: mode.dangerFg, background: mode.canvas, kind: "text" },
    { label: "Success badge", foreground: mode.successFg, background: mode.successBg, kind: "text" },
    { label: "Warning badge", foreground: mode.warningFg, background: mode.warningBg, kind: "text" },
    { label: "Danger badge", foreground: mode.dangerFg, background: mode.dangerBg, kind: "text" },
    { label: "Info badge", foreground: mode.infoFg, background: mode.infoBg, kind: "text" },
    {
      label: "Sidebar inactive label",
      foreground: mode.sidebarMuted,
      background: mode.sidebar,
      kind: "text",
    },
    {
      label: "Sidebar active label",
      foreground: mode.sidebarActiveFg,
      background: mode.sidebarActive,
      kind: "text",
    },
    { label: "Table header", foreground: mode.fg, background: mode.tableHead, kind: "text" },
    { label: "Table cell", foreground: mode.fg, background: mode.card, kind: "text" },
    { label: "Amount on card", foreground: mode.fg, background: mode.card, kind: "text" },
    {
      label: "Display title (large text)",
      foreground: mode.fg,
      background: mode.canvas,
      kind: "large",
    },
    { label: "Border on canvas", foreground: mode.border, background: mode.canvas, kind: "ui" },
    { label: "Border on card", foreground: mode.border, background: mode.card, kind: "ui" },
    {
      label: "Secondary button border",
      foreground: mode.border,
      background: mode.secondary,
      kind: "ui",
    },
    { label: "Focus ring on canvas", foreground: mode.focus, background: mode.canvas, kind: "ui" },
    {
      label: "Primary button on canvas",
      foreground: mode.primary,
      background: mode.canvas,
      kind: "ui",
    },
    {
      label: "Error border on input",
      foreground: mode.dangerBorder,
      background: mode.input,
      kind: "ui",
    },
    {
      label: "Active nav indicator",
      foreground: mode.sidebarAccent,
      background: mode.sidebarActive,
      kind: "ui",
    },
  ];
}

export function studioPairs(): ContrastPair[] {
  return [
    { label: "Studio text on canvas", foreground: studio.fg, background: studio.canvas, kind: "text" },
    { label: "Studio text on panel", foreground: studio.fg, background: studio.panel, kind: "text" },
    { label: "Studio muted on canvas", foreground: studio.muted, background: studio.canvas, kind: "text" },
    { label: "Studio muted on panel", foreground: studio.muted, background: studio.panel, kind: "text" },
    { label: "Studio border on canvas", foreground: studio.border, background: studio.canvas, kind: "ui" },
    { label: "Studio border on panel", foreground: studio.border, background: studio.panel, kind: "ui" },
  ];
}
