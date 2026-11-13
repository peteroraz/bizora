locals {
  github_repository = "peteroraz/bizora"
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"

  # Predictable before the services exist, so the API and web can reference
  # each other without a Terraform cycle. Cloud Run assigns this URL when the
  # DNS label (service name + project number) is at most 63 characters.
  # CI refuses to build the web image if the live service URL differs.
  api_origin = "https://bizora-api-${data.google_project.current.number}.${var.region}.run.app"
  web_origin = "https://bizora-web-${data.google_project.current.number}.${var.region}.run.app"

  artifact_registry_url = "${var.region}-docker.pkg.dev/${var.project_id}/bizora"

  # PASS is URL-encoded. The random password is URL-safe, so encoding does not
  # change it today; it keeps the URI valid if the character set ever grows.
  # Full value is stored in Secret Manager and in Terraform state.
  database_url = "postgres://${google_sql_user.app.name}:${urlencode(random_password.db.result)}@/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.bizora.connection_name}"

  wif_attribute_condition = var.wif_mode == "main_branch" ? (
    "assertion.repository == \"${local.github_repository}\" && assertion.ref == \"refs/heads/main\""
    ) : (
    "assertion.repository == \"${local.github_repository}\" && assertion.environment == \"production\""
  )

  wif_principal_attribute = var.wif_mode == "main_branch" ? "attribute.repository" : "attribute.environment"
  wif_principal_value     = var.wif_mode == "main_branch" ? local.github_repository : "production"
}
