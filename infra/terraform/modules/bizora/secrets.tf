# The database password and the full DATABASE_URL are in this secret version
# and in Terraform state. The state bucket is sensitive. See docs/deployment.md.

resource "google_secret_manager_secret" "database_url" {
  project             = var.project_id
  secret_id           = "bizora-database-url"
  deletion_protection = true

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

# Container only. Do not add a version here. The operator adds the value with
# gcloud after the secret exists and before Cloud Run can start. See the runbook.
resource "google_secret_manager_secret" "jwt" {
  project             = var.project_id
  secret_id           = "bizora-jwt-secret"
  deletion_protection = true

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}
