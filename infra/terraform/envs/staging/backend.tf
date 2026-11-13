terraform {
  backend "gcs" {
    bucket = "bizora-staging-tfstate"
    prefix = "terraform/state"
  }
}
