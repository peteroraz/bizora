const canvas = "#f3f7f6";
const card = "#ffffff";
const ink = "#102221";
const muted = "#3d5552";
const primary = "#115e59";
const primaryInk = "#f0fdfa";

export function renderEmail(input: {
  title: string;
  paragraphs: string[];
  actionLabel?: string;
  actionUrl?: string;
}): { html: string; text: string } {
  const action =
    input.actionLabel && input.actionUrl
      ? `<p style="margin:24px 0"><a href="${escapeAttr(input.actionUrl)}" style="display:inline-block;background:${primary};color:${primaryInk};text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">${escapeHtml(input.actionLabel)}</a></p>`
      : "";
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:${canvas};color:${ink};font-family:Segoe UI,Noto Sans,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:32px 16px">
      <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:${primary}">Bizora</p>
      <div style="background:${card};border-radius:12px;padding:24px">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(input.title)}</h1>
        ${input.paragraphs.map((paragraph) => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(paragraph)}</p>`).join("")}
        ${action}
        ${input.actionUrl ? `<p style="margin:0;color:${muted};font-size:13px;line-height:1.5">If the button does not open, paste this link into your browser:<br>${escapeHtml(input.actionUrl)}</p>` : ""}
      </div>
    </div>
  </body>
</html>`;
  const text = [
    "Bizora",
    "",
    input.title,
    "",
    ...input.paragraphs,
    "",
    input.actionLabel && input.actionUrl ? `${input.actionLabel}: ${input.actionUrl}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { html, text };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
