locals {
  github_repository = "peteroraz/bizora"
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"

  # Predictable before the services exist, so the API and web can reference
  # each other without a Terraform cycle. Cloud Run assigns this URL when the
  # DNS label (service name + project number) is at most 63 characters.
  # CI builds the web image with this origin. status.url is the hash host
  # and is not compared; deploy curls this host instead.
  api_origin = "https://bizora-api-${data.google_project.current.number}.${var.region}.run.app"
  web_origin = "https://bizora-web-${data.google_project.current.number}.${var.region}.run.app"

  artifact_registry_url = "${var.region}-docker.pkg.dev/${var.project_id}/bizora"

  # postgres.js throws Invalid URL when the host is empty, and it does not read a
  # query parameter as a unix socket. The URL stays on localhost. Cloud Run sets
  # DATABASE_SOCKET_DIR to the connector directory and the app passes that as
  # the postgres host option. PASS is URL-encoded. The password and this URL
  # are stored in Secret Manager and in Terraform state.
  database_url        = "postgres://${google_sql_user.app.name}:${urlencode(random_password.db.result)}@localhost/${google_sql_database.app.name}"
  database_socket_dir = "/cloudsql/${google_sql_database_instance.bizora.connection_name}"

  wif_attribute_condition = var.wif_mode == "main_branch" ? (
    "assertion.repository == \"${local.github_repository}\" && assertion.ref == \"refs/heads/main\""
    ) : (
    "assertion.repository == \"${local.github_repository}\" && assertion.environment == \"production\""
  )

  wif_principal_attribute = var.wif_mode == "main_branch" ? "attribute.repository" : "attribute.environment"
  wif_principal_value     = var.wif_mode == "main_branch" ? local.github_repository : "production"
}
