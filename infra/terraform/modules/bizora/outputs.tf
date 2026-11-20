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
  description = "Browser origin injected into bizora-api as WEB_ORIGIN and PUBLIC_WEB_ORIGIN."
  value       = local.web_origin
}

output "web_run_origin" {
  description = "Deterministic run.app origin for bizora-web. It keeps serving during a custom-domain cutover."
  value       = local.run_app_web_origin
}

output "custom_domain_dns_records" {
  description = "DNS records for custom_domain. Create each one in Cloudflare as DNS only (grey cloud)."
  value = var.custom_domain == "" ? [] : flatten([
    for status in google_cloud_run_domain_mapping.web[0].status : [
      for record in status.resource_records : {
        name   = record.name
        type   = record.type
        rrdata = record.rrdata
      }
    ]
  ])
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name (project:region:instance)."
  value       = google_sql_database_instance.bizora.connection_name
}

output "admin_origin" {
  description = "Admin portal origin. Add <admin_origin>/api/admin/v1/auth/google/callback to the Google OAuth client's redirect URIs."
  value       = local.admin_origin
}

output "admin_custom_domain_dns_records" {
  description = "DNS records for admin_custom_domain. Create each one in Cloudflare as DNS only (grey cloud)."
  value = var.admin_custom_domain == "" ? [] : flatten([
    for status in google_cloud_run_domain_mapping.admin[0].status : [
      for record in status.resource_records : {
        name   = record.name
        type   = record.type
        rrdata = record.rrdata
      }
    ]
  ])
}
