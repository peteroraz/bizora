variable "project_id" {
  type        = string
  description = "GCP project id for this environment."
}

variable "region" {
  type        = string
  description = "Region for every regional resource. Bizora is pinned to europe-west1."
  default     = "europe-west1"

  validation {
    condition     = var.region == "europe-west1"
    error_message = "All Bizora resources must be created in europe-west1."
  }
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier. Staging uses db-f1-micro. Production uses db-g1-small."
}

variable "db_point_in_time_recovery" {
  type        = bool
  description = "Enable Cloud SQL point-in-time recovery. Production only."
}

variable "api_min_instances" {
  type        = number
  description = "Minimum bizora-api instances. Staging is 0. Production is 1. Maximum is fixed at 1."

  validation {
    condition     = var.api_min_instances == 0 || var.api_min_instances == 1
    error_message = "api_min_instances must be 0 or 1. The API max instance count is fixed at 1."
  }
}

variable "web_min_instances" {
  type        = number
  description = "Minimum bizora-web instances. Staging is 0. Production is 1."

  validation {
    condition     = var.web_min_instances == 0 || var.web_min_instances == 1
    error_message = "web_min_instances must be 0 or 1."
  }
}

variable "invite_token_expose" {
  type        = bool
  description = "When true, the API includes invite tokens in responses. Staging only."
}

variable "wif_mode" {
  type        = string
  description = "GitHub Actions identity allowed to impersonate the deployer. main_branch (staging) or production_environment (prod)."

  validation {
    condition     = contains(["main_branch", "production_environment"], var.wif_mode)
    error_message = "wif_mode must be main_branch or production_environment."
  }
}
