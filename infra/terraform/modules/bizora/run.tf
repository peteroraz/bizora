# Cloud Run is created with the public hello image. CI owns the image after
# that. ignore_changes keeps Terraform from rolling the image back to hello.
#
# The first apply cannot finish these services until bizora-jwt-secret has a
# version. Add that version manually, then apply again. See docs/deployment.md.
#
# bizora-api can run on several instances: sign-in limits are kept in Postgres
# (ADR-036), and nothing else is held in memory between requests.

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
      max_instance_count = var.api_max_instances
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
        name  = "PUBLIC_WEB_ORIGIN"
        value = local.web_origin
      }
      env {
        name  = "EMAIL_PROVIDER"
        value = var.email_provider
      }
      dynamic "env" {
        for_each = var.email_from == "" ? [] : [var.email_from]
        content {
          name  = "EMAIL_FROM"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.email_provider == "resend" ? [1] : []
        content {
          name = "EMAIL_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.email_api_key.secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.google_oauth_client_id == "" ? [] : [var.google_oauth_client_id]
        content {
          name  = "GOOGLE_OAUTH_CLIENT_ID"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.google_oauth_client_id == "" ? [] : [1]
        content {
          name = "GOOGLE_OAUTH_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.google_oauth_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      env {
        name  = "INVITE_TOKEN_EXPOSE"
        value = var.invite_token_expose ? "true" : "false"
      }
      env {
        name  = "AI_PROVIDER"
        value = var.ai_provider
      }
      env {
        name  = "VERTEX_PROJECT"
        value = var.project_id
      }
      env {
        name  = "VERTEX_LOCATION"
        value = var.vertex_location
      }
      env {
        name  = "VERTEX_MODEL"
        value = var.vertex_model
      }
      env {
        name  = "AI_DAILY_CAPTURE_LIMIT"
        value = tostring(var.ai_daily_capture_limit)
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
        name  = "DATABASE_SOCKET_DIR"
        value = local.database_socket_dir
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
    google_secret_manager_secret_iam_member.api_google_oauth,
    google_secret_manager_secret_iam_member.api_email,
    google_project_iam_member.api_cloudsql,
    google_project_iam_member.api_vertex,
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
        env {
          name  = "DATABASE_SOCKET_DIR"
          value = local.database_socket_dir
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
