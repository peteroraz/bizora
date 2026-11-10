variable "project_id" {
  type        = string
  description = "Google Cloud project ID"
}

variable "region" {
  type        = string
  default     = "europe-west1"
}

variable "db_tier" {
  type    = string
  default = "db-f1-micro"
}
