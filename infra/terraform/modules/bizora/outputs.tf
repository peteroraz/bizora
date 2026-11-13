output "wif_provider" {
  description = "Full Workload Identity Provider resource name. GitHub variable GCP_WIF_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Deployer service account email. GitHub variable GCP_DEPLOYER_SA."
  value       = google_service_account.deployer.email
}

output "artifact_registry_url" {
  description = "Docker host and repository, without an image name."
  value       = local.artifact_registry_url
}

output "api_url" {
  description = "URL Cloud Run reports for bizora-api."
  value       = google_cloud_run_v2_service.api.uri
}

output "web_url" {
  description = "URL Cloud Run reports for bizora-web."
  value       = google_cloud_run_v2_service.web.uri
}

output "api_origin" {
  description = "WEB-facing API origin injected into bizora-web and baked into the web image by CI."
  value       = local.api_origin
}

output "web_origin" {
  description = "Browser origin injected into bizora-api as WEB_ORIGIN."
  value       = local.web_origin
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)."
  value       = google_sql_database_instance.bizora.connection_name
}
