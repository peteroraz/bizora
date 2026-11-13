module "bizora" {
  source = "../../modules/bizora"

  project_id                = var.project_id
  region                    = var.region
  db_tier                   = var.db_tier
  db_point_in_time_recovery = var.db_point_in_time_recovery
  api_min_instances         = var.api_min_instances
  web_min_instances         = var.web_min_instances
  invite_token_expose       = var.invite_token_expose
  wif_mode                  = var.wif_mode
}
