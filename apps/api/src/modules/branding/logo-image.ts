import { createHash } from "node:crypto";
import { LOGO_MAX_BYTES, LOGO_MAX_SIDE, LOGO_MIN_SIDE, type LogoType } from "@bizora/contracts";
import PDFDocument from "pdfkit";

export type LogoImage = { contentType: LogoType; data: Buffer; width: number; height: number; sha256: string };
export type LogoProblem = "not_image" | "too_big" | "too_small" | "too_large_pixels" | "unreadable";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the file itself, not from what the browser said. */
export function imageSize(data: Buffer): { type: LogoType; width: number; height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG) && data.subarray(12, 16).toString("latin1") === "IHDR") {
    return { type: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = data.readUInt16BE(offset + 2);
      // Start-of-frame markers carry the size; C4 (Huffman), C8 and CC (arithmetic coding tables) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "image/jpeg", height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

/** Checks an uploaded logo: a real PNG or JPEG, within the limits, and one the PDF library can print. */
export function inspectLogo(data: Buffer): LogoImage | LogoProblem {
  if (data.length > LOGO_MAX_BYTES) return "too_big";
  const size = imageSize(data);
  if (!size) return "not_image";
  if (size.width < LOGO_MIN_SIDE || size.height < LOGO_MIN_SIDE) return "too_small";
  if (size.width > LOGO_MAX_SIDE || size.height > LOGO_MAX_SIDE) return "too_large_pixels";
  try {
    // openImage is in pdfkit but missing from its types.
    (new PDFDocument({ autoFirstPage: false }) as unknown as { openImage(source: Buffer): unknown }).openImage(data);
  } catch {
    return "unreadable";
  }
  return { contentType: size.type, data, width: size.width, height: size.height, sha256: createHash("sha256").update(data).digest("hex") };
}
