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
