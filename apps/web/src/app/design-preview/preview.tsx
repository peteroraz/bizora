import type { CSSProperties } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { contrastPairs, palettes, studio } from "@/design/palettes";
import { fontProposal, radii, shadows, spacingScale, typeScale } from "@/design/typography";
import { PaletteSpecimen, RatioList } from "./specimen";

const sans = Geist({
  subsets: ["latin"],
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
});

export function DesignPreview() {
  return (
    <div
      className={sans.className}
      style={{
        minHeight: "100vh",
        background: studio.canvas,
        color: studio.fg,
        fontFamily: `${sans.style.fontFamily}, "Segoe UI", "Noto Sans", sans-serif`,
      }}
    >
      <style>{`
        .dp-focus { outline: none; }
        .dp-focus:focus-visible {
          outline: 2px solid var(--dp-focus);
          outline-offset: 2px;
        }
        .dp-specimen { container-type: inline-size; }
        .dp-layout { display: grid; grid-template-columns: 132px minmax(0, 1fr); }
        @container (max-width: 460px) {
          .dp-layout { grid-template-columns: 1fr; }
        }
      `}</style>
      <main style={{ maxWidth: 1440, margin: "0 auto", padding: "32px 20px 64px" }}>
        <p
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: "16px",
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: studio.muted,
          }}
        >
          Sprint 3A · Dev only
        </p>
        <h1 style={{ margin: "8px 0 0", fontSize: 36, lineHeight: "44px", fontWeight: 600 }}>
          Design direction
        </h1>
        <p style={{ maxWidth: 760, margin: "12px 0 0", fontSize: 16, lineHeight: "24px", color: studio.muted }}>
          Three palettes for a calm, professional Bizora. Light and dark are both first-class. Compare
          A, B, and C. Type, spacing, radius, and shadow are shared. This route returns 404 when
          NODE_ENV is production.
        </p>
        <p style={{ maxWidth: 760, margin: "8px 0 0", fontSize: 14, lineHeight: "20px", color: studio.muted }}>
          Dark primary buttons use a light fill and dark label so the button shape stays at least 3:1
          against a near-black canvas. Borders are stronger than a typical hairline for the same
          reason. Badge edges reuse the badge text colour. Active navigation uses a 3:1 accent bar,
          not the tint alone. Ratios use WCAG 2.x relative luminance.
        </p>

        <section style={{ marginTop: 36 }}>
          <h2 style={{ margin: 0, fontSize: 24, lineHeight: "32px", fontWeight: 600 }}>Typography</h2>
          <p style={{ maxWidth: 760, margin: "8px 0 0", fontSize: 16, lineHeight: "24px" }}>
            {fontProposal.family} for interface text, {fontProposal.mono} for identifiers. Loaded with{" "}
            {fontProposal.source}. Missing glyphs, including ₦ if the latin subset omits it, fall
            through to {fontProposal.fallback}. {fontProposal.reason}
          </p>

          <div
            style={{
              marginTop: 16,
              background: studio.panel,
              border: `1px solid ${studio.border}`,
              borderRadius: 12,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {typeScale.map((step) => (
              <div
                key={step.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr)",
                  gap: 2,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: step.size,
                    lineHeight: `${step.line}px`,
                    fontWeight: step.weight,
                  }}
                >
                  {step.name} {step.size}/{step.line}
                </p>
                <p style={{ margin: 0, color: studio.muted, fontSize: 12, lineHeight: "16px", fontWeight: 500 }}>
                  Weight {step.weight} · {step.use}
                </p>
              </div>
            ))}
            <p style={{ margin: "8px 0 0", fontFamily: mono.style.fontFamily, fontSize: 14, lineHeight: "20px" }}>
              INV-1042 · Geist Mono
            </p>
          </div>
        </section>

        <section style={{ marginTop: 28, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          <div style={panelStyle}>
            <h2 style={panelTitle}>Spacing</h2>
            <p style={panelCopy}>4px base. Tailwind’s default scale covers every step.</p>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: 12 }}>
              {spacingScale.map((step) => (
                <div key={step} style={{ textAlign: "center" }}>
                  <div style={{ width: step, height: step, background: studio.fg, borderRadius: 2 }} />
                  <div style={{ marginTop: 4, fontSize: 12, lineHeight: "16px", color: studio.muted }}>{step}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={panelStyle}>
            <h2 style={panelTitle}>Radius</h2>
            <p style={panelCopy}>Controls 8, cards 12, overlays 16, badges pill.</p>
            <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
              {radii
                .filter((radius) => radius.value < 999)
                .map((radius) => (
                  <div key={radius.name} style={{ textAlign: "center" }}>
                    <div
                      style={{
                        width: 64,
                        height: 40,
                        borderRadius: radius.value,
                        border: `1px solid ${studio.border}`,
                        background: studio.canvas,
                      }}
                    />
                    <div style={{ marginTop: 4, fontSize: 12, lineHeight: "16px" }}>
                      {radius.name} {radius.value}
                    </div>
                  </div>
                ))}
            </div>
          </div>
          <div style={panelStyle}>
            <h2 style={panelTitle}>Shadow</h2>
            <p style={panelCopy}>Dark mode leans on the border and keeps only the small card shadow.</p>
            <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
              {shadows.map((shadow) => (
                <div key={shadow.name} style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: 64,
                      height: 40,
                      borderRadius: 12,
                      background: studio.panel,
                      boxShadow: shadow.value,
                      border: `1px solid ${studio.border}`,
                    }}
                  />
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: "16px" }}>{shadow.name}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section style={{ marginTop: 36 }}>
          <h2 style={{ margin: 0, fontSize: 24, lineHeight: "32px", fontWeight: 600 }}>Palettes</h2>
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gap: 20,
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
            }}
          >
            {palettes.map((palette) => (
              <article key={palette.id}>
                <h3 style={{ margin: 0, fontSize: 18, lineHeight: "28px", fontWeight: 600 }}>
                  {palette.id} · {palette.name}
                </h3>
                <p style={{ margin: "4px 0 12px", color: studio.muted, fontSize: 14, lineHeight: "20px" }}>
                  {palette.note}
                </p>
                {(["light", "dark"] as const).map((modeId) => {
                  const mode = palette[modeId];
                  return (
                    <div key={modeId} style={{ marginBottom: 16 }}>
                      <h4 style={{ margin: "0 0 8px", fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>
                        {modeId === "light" ? "Light" : "Dark"}
                      </h4>
                      <PaletteSpecimen mode={mode} idPrefix={`${palette.id}-${modeId}`} />
                    </div>
                  );
                })}
                <div
                  style={{
                    marginTop: 4,
                    paddingTop: 16,
                    borderTop: `1px solid ${studio.border}`,
                  }}
                >
                  <h4 style={{ margin: "0 0 12px", fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>
                    Measured contrast
                  </h4>
                  {(["light", "dark"] as const).map((modeId) => (
                    <div key={`${modeId}-ratios`} style={{ marginBottom: 12 }}>
                      <h5 style={{ margin: "0 0 4px", fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>
                        {modeId === "light" ? "Light" : "Dark"}
                      </h5>
                      <RatioList pairs={contrastPairs(palette[modeId])} />
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

const panelStyle: CSSProperties = {
  background: studio.panel,
  border: `1px solid ${studio.border}`,
  borderRadius: 12,
  padding: 16,
};

const panelTitle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  lineHeight: "28px",
  fontWeight: 600,
};

const panelCopy: CSSProperties = {
  margin: "6px 0 0",
  color: studio.muted,
  fontSize: 14,
  lineHeight: "20px",
};
