/** The palette preview is a local design tool. Production builds 404 the route. */
export function designPreviewAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
