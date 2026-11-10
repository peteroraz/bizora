resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "storage.googleapis.com",
  ])
  service = each.key
}

resource "google_sql_database_instance" "bizora" {
  name             = "bizora-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  depends_on       = [google_project_service.services]
  settings {
    tier = var.db_tier
    backup_configuration {
      enabled = true
    }
  }
}

resource "google_sql_database" "bizora" {
  name     = "bizora"
  instance = google_sql_database_instance.bizora.name
}

resource "google_artifact_registry_repository" "bizora" {
  location      = var.region
  repository_id = "bizora"
  format        = "DOCKER"
  depends_on    = [google_project_service.services]
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.bizora.connection_name
}
