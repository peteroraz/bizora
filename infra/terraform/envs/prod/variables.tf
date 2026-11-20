variable "project_id" {
  type        = string
  description = "GCP project id."
}

variable "region" {
  type        = string
  description = "Region for every regional resource."
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier."
}

variable "db_point_in_time_recovery" {
  type        = bool
  description = "Enable Cloud SQL point-in-time recovery."
}

variable "api_min_instances" {
  type        = number
  description = "Minimum bizora-api instances."
}

variable "web_min_instances" {
  type        = number
  description = "Minimum bizora-web instances."
}

variable "invite_token_expose" {
  type        = bool
  description = "Expose invite tokens in API responses."
}

variable "wif_mode" {
  type        = string
  description = "GitHub identity allowed to deploy. main_branch or production_environment."
}

variable "api_max_instances" {
  type        = number
  description = "Maximum bizora-api instances (ADR-036)."
  default     = 4
}

variable "alert_emails" {
  type        = list(string)
  description = "Who is emailed when Bizora is down or failing (ADR-036)."
  default     = []
}

variable "admin_custom_domain" {
  type        = string
  description = "Admin portal hostname without a scheme (ADR-037). Empty keeps the run.app origin."
  default     = ""
}

variable "admin_bootstrap_emails" {
  type        = list(string)
  description = "Google accounts that become super admins the first time they sign in to the Admin portal (ADR-037)."
  default     = []
}
