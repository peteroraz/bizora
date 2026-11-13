resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "-_"
  min_lower        = 2
  min_upper        = 2
  min_numeric      = 2
  min_special      = 2
}

resource "google_sql_database_instance" "bizora" {
  project          = var.project_id
  name             = "bizora-pg"
  region           = var.region
  database_version = "POSTGRES_16"

  # Terraform-level guard. settings.deletion_protection_enabled is the API flag
  # that also blocks gcloud and the console.
  deletion_protection = true

  settings {
    tier    = var.db_tier
    edition = "ENTERPRISE"

    # Shared-core tiers are zonal. High availability is not available on
    # db-f1-micro or db-g1-small.
    availability_type           = "ZONAL"
    deletion_protection_enabled = true
    connector_enforcement       = "REQUIRED"

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
      # No authorized_networks. The public address accepts nothing. Cloud Run
      # reaches Postgres only through the Cloud SQL connector unix socket.
      # See docs/adr/ADR-005-cloud-sql-connector.md.
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = var.db_point_in_time_recovery
      transaction_log_retention_days = var.db_point_in_time_recovery ? 7 : null

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }

    # Sunday 02:00 UTC. Day 1 is Monday.
    maintenance_window {
      day          = 7
      hour         = 2
      update_track = "stable"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = "bizora"
  instance = google_sql_database_instance.bizora.name
}

resource "google_sql_user" "app" {
  project  = var.project_id
  name     = "bizora_app"
  instance = google_sql_database_instance.bizora.name
  password = random_password.db.result
}
