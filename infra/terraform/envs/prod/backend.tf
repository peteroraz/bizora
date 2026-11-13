terraform {
  backend "gcs" {
    bucket = "bizora-productions-tfstate"
    prefix = "terraform/state"
  }
}
