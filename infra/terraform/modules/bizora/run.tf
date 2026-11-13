# Cloud Run is created with the public hello image. CI owns the image after
# that. ignore_changes keeps Terraform from rolling the image back to hello.
#
# The first apply cannot finish these services until bizora-jwt-secret has a
# version. Add that version manually, then apply again. See docs/deployment.md.
#
# bizora-api max_instance_count is 1 because the auth throttler is in-memory.
# Do not raise it until Redis-backed storage exists.
# See "Known limitations" in README.md and docs/deployment.md.

resource "google_cloud_run_v2_service" "api" {
  project             = var.project_id
  name                = "bizora-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = var.api_min_instances
      # In-memory throttler. Keep this at 1. See Known limitations.
      max_instance_count = 1
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.bizora.connection_name]
      }
    }

    containers {
      image = local.placeholder_image

      ports {
        name           = "http1"
        container_port = 3001
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "API_PORT"
        value = "3001"
      }
      env {
        name  = "TRUST_PROXY"
        value = "true"
      }
      env {
        name  = "COOKIE_SECURE"
        value = "true"
      }
      env {
        name  = "WEB_ORIGIN"
        value = local.web_origin
      }
      env {
        name  = "INVITE_TOKEN_EXPOSE"
        value = var.invite_token_expose ? "true" : "false"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt.secret_id
            version = "latest"
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 18
        http_get {
          path = "/health"
          port = 3001
        }
      }

      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 30
        failure_threshold = 3
        http_get {
          path = "/health"
          port = 3001
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_iam_member.api_database_url,
    google_secret_manager_secret_iam_member.api_jwt,
    google_project_iam_member.api_cloudsql,
    google_service_account_iam_member.deployer_api,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  project             = var.project_id
  name                = "bizora-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = 3
    }

    containers {
      image = local.placeholder_image

      ports {
        name           = "http1"
        container_port = 3000
      }

      env {
        name  = "API_ORIGIN"
        value = local.api_origin
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = "bizora-migrate"
  location            = var.region
  deletion_protection = true

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = google_service_account.migrate.email
      timeout         = "600s"
      max_retries     = 0

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.bizora.connection_name]
        }
      }

      containers {
        image       = local.placeholder_image
        command     = ["node"]
        args        = ["dist/db/migrate.js"]
        working_dir = "/app"

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_iam_member.migrate_database_url,
    google_project_iam_member.migrate_cloudsql,
    google_service_account_iam_member.deployer_migrate,
  ]
}
