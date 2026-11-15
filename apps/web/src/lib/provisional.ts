import { provisionalNumber } from "@bizora/contracts";

/**
 * Numbers a phone gives sales made with no network (ADR-012), such as DEV417-000045. Each phone picks its own
 * code once, so two phones rarely show the same number. The server gives the official receipt number when the sale
 * syncs; receipts show both, so a customer holding the offline number can still be found.
 */
const CODE_KEY = "bizora.deviceCode";
const SEQ_KEY = "bizora.provisionalSeq";

function deviceCode() {
  const saved = Number(localStorage.getItem(CODE_KEY) ?? "0");
  if (saved > 0) return saved;
  const code = 100 + Math.floor(Math.random() * 900);
  localStorage.setItem(CODE_KEY, String(code));
  return code;
}

export function nextProvisionalNumber() {
  try {
    const sequence = Number(localStorage.getItem(SEQ_KEY) ?? "0") + 1;
    localStorage.setItem(SEQ_KEY, String(sequence));
    return provisionalNumber(deviceCode(), sequence);
  } catch {
    // Storage can be unavailable (private mode).
    return `OFF-${Date.now().toString().slice(-6)}`;
  }
}
