module "bizora" {
  source = "../../modules/bizora"

  project_id                = var.project_id
  region                    = var.region
  db_tier                   = var.db_tier
  db_point_in_time_recovery = var.db_point_in_time_recovery
  api_min_instances         = var.api_min_instances
  api_max_instances         = var.api_max_instances
  alert_emails              = var.alert_emails
  environment               = "production"
  admin_custom_domain       = var.admin_custom_domain
  admin_bootstrap_emails    = var.admin_bootstrap_emails
  web_min_instances         = var.web_min_instances
  invite_token_expose       = var.invite_token_expose
  wif_mode                  = var.wif_mode
}
