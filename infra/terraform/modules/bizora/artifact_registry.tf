resource "google_artifact_registry_repository" "bizora" {
  project       = var.project_id
  location      = var.region
  repository_id = "bizora"
  format        = "DOCKER"
  description   = "Bizora API and web images. CI tags images with the git SHA."

  # KEEP wins over DELETE. Everything except the 15 newest versions of each
  # package is eligible for deletion. Cleanup runs on Google's daily job.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-all-versions"
    action = "DELETE"
    condition {
      tag_state = "ANY"
    }
  }

  cleanup_policies {
    id     = "keep-last-15"
    action = "KEEP"
    most_recent_versions {
      keep_count = 15
    }
  }

  depends_on = [google_project_service.required]
}
