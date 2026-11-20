/**
 * Errors while the web server renders a page go to Cloud Error Reporting (ADR-036), in the same format as the API's.
 */
export async function onRequestError(error: unknown, request: { path: string; method: string; headers: Record<string, string | string[] | undefined> }) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const path = (request.path.split("?")[0] ?? "").replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/:token");
  console.error(
    JSON.stringify({
      severity: "ERROR",
      "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
      message: failure.stack ?? `${failure.name}: ${failure.message}`,
      serviceContext: { service: "bizora-web", version: process.env.K_REVISION ?? "local" },
      context: { httpRequest: { method: request.method, url: path } },
    }),
  );
}
