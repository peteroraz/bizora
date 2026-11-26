/**
 * Loads a part of a screen that is fetched after the screen opens. If the network went before the part arrived, a
 * plain import fails and React shows "Application error" for the whole screen. This waits for the network to come
 * back (or tries again every few seconds) and loads it then, so the screen keeps working and the part appears later.
 */
export const PATIENT_RETRY_MS = 5_000;

export function patientImport<T>(load: () => Promise<T>, retryMs = PATIENT_RETRY_MS): () => Promise<T> {
  let loading: Promise<T> | null = null;
  const attempt = (): Promise<T> =>
    load().catch(
      () =>
        new Promise<T>((resolve) => {
          const again = () => {
            window.removeEventListener("online", again);
            window.clearTimeout(timer);
            resolve(attempt());
          };
          window.addEventListener("online", again);
          const timer = window.setTimeout(again, retryMs);
        }),
    );
  // One load shared by everyone asking, so the background warm-up and the screen wait on the same attempt.
  return () => (loading ??= attempt());
}
