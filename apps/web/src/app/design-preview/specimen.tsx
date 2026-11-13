import type { CSSProperties, ReactNode } from "react";
import { contrastRatio, formatRatio, minimumRatio, type ContrastPair } from "@/design/contrast";
import { type PaletteMode, studio } from "@/design/palettes";

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d="M2.75 7.1 8 2.9l5.25 4.2V13a.75.75 0 0 1-.75.75H10v-3.2H6v3.2H3.5a.75.75 0 0 1-.75-.75V7.1Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M12.6 3.4l-1.05 1.05M4.45 11.55 3.4 12.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Badge({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        color: fg,
        background: bg,
        border: `1px solid ${fg}`,
        borderRadius: 999,
        padding: "2px 8px",
        fontSize: 12,
        lineHeight: "16px",
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  );
}

function NavItem({
  label,
  icon,
  mode,
  active,
}: {
  label: string;
  icon: ReactNode;
  mode: PaletteMode;
  active?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderRadius: 8,
        padding: "8px 10px",
        background: active ? mode.sidebarActive : "transparent",
        color: active ? mode.sidebarActiveFg : mode.sidebarMuted,
        boxShadow: active ? `inset 3px 0 0 ${mode.sidebarAccent}` : undefined,
        fontSize: 14,
        lineHeight: "20px",
        fontWeight: active ? 600 : 500,
      }}
    >
      {icon}
      {label}
    </div>
  );
}

export function PaletteSpecimen({ mode, idPrefix }: { mode: PaletteMode; idPrefix: string }) {
  const fieldId = `${idPrefix}-business`;
  const errorId = `${idPrefix}-business-error`;

  return (
    <div
      className="dp-specimen"
      style={
        {
          background: mode.canvas,
          color: mode.fg,
          border: `1px solid ${mode.border}`,
          borderRadius: 12,
          overflow: "hidden",
          colorScheme: mode.id,
          "--dp-focus": mode.focus,
        } as CSSProperties
      }
    >
      <div className="dp-layout">
        <div
          style={{
            background: mode.sidebar,
            color: mode.sidebarFg,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ padding: "6px 10px 10px", fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>
            Bizora
          </div>
          <NavItem label="Home" icon={<HomeIcon />} mode={mode} />
          <NavItem label="Settings" icon={<SettingsIcon />} mode={mode} active />
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button
              type="button"
              className="dp-focus"
              style={{
                height: 36,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid transparent",
                background: mode.primary,
                color: mode.primaryFg,
                fontSize: 14,
                lineHeight: "20px",
                fontWeight: 500,
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="dp-focus"
              style={{
                height: 36,
                padding: "0 14px",
                borderRadius: 8,
                border: `1px solid ${mode.border}`,
                background: mode.secondary,
                color: mode.secondaryFg,
                fontSize: 14,
                lineHeight: "20px",
                fontWeight: 500,
              }}
            >
              Cancel
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor={fieldId} style={{ fontSize: 14, lineHeight: "20px", fontWeight: 500 }}>
              Business name
            </label>
            <input
              id={fieldId}
              className="dp-focus"
              aria-invalid="true"
              aria-describedby={errorId}
              defaultValue=""
              style={{
                height: 36,
                width: "100%",
                boxSizing: "border-box",
                borderRadius: 8,
                border: `1px solid ${mode.dangerBorder}`,
                background: mode.input,
                color: mode.fg,
                padding: "0 12px",
                fontSize: 14,
                lineHeight: "20px",
              }}
            />
            <p id={errorId} style={{ margin: 0, color: mode.dangerFg, fontSize: 12, lineHeight: "16px", fontWeight: 500 }}>
              Enter a business name.
            </p>
          </div>

          <div
            style={{
              background: mode.card,
              border: `1px solid ${mode.border}`,
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 1px 2px rgb(16 24 20 / 0.06), 0 1px 1px rgb(16 24 20 / 0.04)",
            }}
          >
            <p
              style={{
                margin: 0,
                color: mode.muted,
                fontSize: 12,
                lineHeight: "16px",
                fontWeight: 500,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              Collected
            </p>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 24,
                lineHeight: "32px",
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              ₦1,250,000.00
            </p>
            <p
              style={{
                margin: "2px 0 0",
                color: mode.muted,
                fontSize: 14,
                lineHeight: "20px",
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              $19.99
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
              <Badge label="Success" fg={mode.successFg} bg={mode.successBg} />
              <Badge label="Warning" fg={mode.warningFg} bg={mode.warningBg} />
              <Badge label="Danger" fg={mode.dangerFg} bg={mode.dangerBg} />
              <Badge label="Info" fg={mode.infoFg} bg={mode.infoBg} />
            </div>
          </div>

          <div style={{ border: `1px solid ${mode.border}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, lineHeight: "20px" }}>
              <thead>
                <tr style={{ background: mode.tableHead, textAlign: "left" }}>
                  <th style={headCell}>Ref</th>
                  <th style={headCell}>Status</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ background: mode.card }}>
                  <td style={bodyCell}>INV-1042</td>
                  <td style={bodyCell}>
                    <Badge label="Paid" fg={mode.successFg} bg={mode.successBg} />
                  </td>
                  <td style={{ ...bodyCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    ₦1,250,000.00
                  </td>
                </tr>
                <tr style={{ background: mode.card }}>
                  <td style={{ ...bodyCell, borderTop: `1px solid ${mode.border}` }}>INV-1048</td>
                  <td style={{ ...bodyCell, borderTop: `1px solid ${mode.border}` }}>
                    <Badge label="Open" fg={mode.infoFg} bg={mode.infoBg} />
                  </td>
                  <td
                    style={{
                      ...bodyCell,
                      borderTop: `1px solid ${mode.border}`,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    $19.99
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const headCell: CSSProperties = {
  padding: "8px 10px",
  fontSize: 12,
  lineHeight: "16px",
  fontWeight: 600,
};

const bodyCell: CSSProperties = {
  padding: "8px 10px",
  fontVariantNumeric: "tabular-nums",
};

function kindLabel(kind: ContrastPair["kind"]): string {
  if (kind === "text") return "text ≥ 4.5";
  if (kind === "large") return "large ≥ 3";
  return "UI ≥ 3";
}

export function RatioList({ pairs }: { pairs: ContrastPair[] }) {
  const measured = pairs.map((pair) => ({
    pair,
    ratio: contrastRatio(pair.foreground, pair.background),
  }));
  const lowest = (kind: "text" | "ui") =>
    measured
      .filter((item) => item.pair.kind === kind)
      .reduce((min, item) => (item.ratio < min.ratio ? item : min));

  const lowestText = lowest("text");
  const lowestUi = lowest("ui");

  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ margin: "0 0 8px", color: studio.muted, fontSize: 12, lineHeight: "16px" }}>
        Lowest text {formatRatio(lowestText.ratio)} ({lowestText.pair.label}). Lowest UI{" "}
        {formatRatio(lowestUi.ratio)} ({lowestUi.pair.label}).
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {measured.map(({ pair, ratio }) => (
          <div
            key={pair.label}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              gap: 12,
              fontSize: 12,
              lineHeight: "16px",
            }}
          >
            <span>{pair.label}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, whiteSpace: "nowrap" }}>
              {formatRatio(ratio)}{" "}
              <span style={{ color: studio.muted, fontWeight: 500 }}>({kindLabel(pair.kind)})</span>
            </span>
          </div>
        ))}
      </div>
      <p style={{ margin: "8px 0 0", color: studio.muted, fontSize: 12, lineHeight: "16px" }}>
        Floor used by the check is {minimumRatio("text").toFixed(1)}:1 for text and{" "}
        {minimumRatio("ui").toFixed(1)}:1 for large text and UI.
      </p>
    </div>
  );
}
