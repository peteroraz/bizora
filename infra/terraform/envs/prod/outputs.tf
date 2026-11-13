output "wif_provider" {
  description = "GitHub variable GCP_WIF_PROVIDER."
  value       = module.bizora.wif_provider
}

output "deployer_service_account" {
  description = "GitHub variable GCP_DEPLOYER_SA."
  value       = module.bizora.deployer_service_account
}

output "artifact_registry_url" {
  description = "Artifact Registry Docker host and repository."
  value       = module.bizora.artifact_registry_url
}

output "api_url" {
  description = "bizora-api Cloud Run URL."
  value       = module.bizora.api_url
}

output "web_url" {
  description = "bizora-web Cloud Run URL."
  value       = module.bizora.web_url
}

output "api_origin" {
  description = "API origin configured on bizora-web."
  value       = module.bizora.api_origin
}

output "web_origin" {
  description = "Web origin configured on bizora-api."
  value       = module.bizora.web_origin
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name."
  value       = module.bizora.cloud_sql_connection_name
}
