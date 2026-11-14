# Staging maps bizora-web onto bizora-staging.baseportals.app.
# Production stays on run.app until a global external HTTPS load balancer is designed.
# An empty custom_domain creates no mapping, so this resource cannot block a deploy.
resource "google_cloud_run_domain_mapping" "web" {
  count    = var.custom_domain == "" ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = var.custom_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name       = google_cloud_run_v2_service.web.name
    certificate_mode = "AUTOMATIC"
  }

  depends_on = [google_project_service.required]
}
