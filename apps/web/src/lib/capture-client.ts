/**
 * Prepares photos, scans and voice notes for AI capture (ADR-018). Photos are shrunk on the phone so they upload
 * quickly on slow networks; the text stays readable at 2000 pixels.
 */
const MAX_SIDE = 2000;

function base64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function fileToCapture(file: File): Promise<{ mimeType: string; data: string }> {
  if (file.type.startsWith("image/") && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (blob) return { mimeType: "image/jpeg", data: base64(await blob.arrayBuffer()) };
    } catch {
      // Not a picture the browser can draw; send it as it is.
    }
  }
  return { mimeType: audioType(file) ?? (file.type || "application/octet-stream"), data: base64(await file.arrayBuffer()) };
}

/** Voice notes from other apps: WhatsApp's .opus files often come with no type, iPhones send x-m4a (ADR-033). */
function audioType(file: File) {
  const type = file.type.split(";")[0] ?? "";
  if (type === "audio/opus" || type === "audio/x-opus+ogg") return "audio/ogg";
  if (type && type !== "application/octet-stream") return type;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return ({ opus: "audio/ogg", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", amr: "audio/amr", webm: "audio/webm", "3gp": "audio/3gpp" } as Record<string, string>)[extension] ?? null;
}

/**
 * A product photo (ADR-033): shrunk to at most 1280 pixels a side as a JPEG, usually 100–250 KB, so it uploads
 * quickly and fits the server's limit. Null when the browser cannot read the picture.
 */
export async function photoToUpload(file: File): Promise<{ contentType: "image/jpeg"; dataBase64: string } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    return blob ? { contentType: "image/jpeg", dataBase64: base64(await blob.arrayBuffer()) } : null;
  } catch {
    return null;
  }
}

export async function blobToCapture(blob: Blob): Promise<{ mimeType: string; data: string }> {
  // Browsers add codec details ("audio/webm;codecs=opus"); the server wants the plain type.
  return { mimeType: (blob.type || "audio/webm").split(";")[0] as string, data: base64(await blob.arrayBuffer()) };
}

/** The best recording format this browser supports: webm on Chrome and Android, mp4 on iPhone. */
export function recordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}
