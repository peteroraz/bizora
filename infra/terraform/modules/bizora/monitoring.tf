# Alerts and an uptime check (ADR-036). Errors from the API and the web server
# are written in Error Reporting's format, so Error Reporting groups them; the
# policies below tell the people in var.alert_emails when something is wrong.

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_emails)

  project      = var.project_id
  display_name = "Bizora alerts: ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.required]
}

# The custom domain when there is one; /health goes through the web app to the API.
locals {
  alert_channels = [for channel in google_monitoring_notification_channel.email : channel.id]
  uptime_host    = var.custom_domain
}

resource "google_monitoring_uptime_check_config" "health" {
  count = local.uptime_host == "" ? 0 : 1

  project      = var.project_id
  display_name = "Bizora health (${local.uptime_host})"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.uptime_host
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "down" {
  count = local.uptime_host == "" ? 0 : 1

  project               = var.project_id
  display_name          = "Bizora is not answering"
  combiner              = "OR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "Health check failing from more than one place"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.health[0].uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
    }
  }

  documentation {
    content   = "The health check at https://${local.uptime_host}/health is failing. Check the bizora-web and bizora-api Cloud Run services and the database. See docs/runbooks/incidents.md."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "server_errors" {
  project               = var.project_id
  display_name          = "Bizora is giving server errors"
  combiner              = "OR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "More than 5 server errors (5xx) in 5 minutes"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND (resource.label.service_name=\"bizora-api\" OR resource.label.service_name=\"bizora-web\") AND metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  documentation {
    content   = "Server errors on Bizora. Open Error Reporting for the stack traces and the business affected. See docs/runbooks/incidents.md."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required]
}

resource "google_logging_metric" "errors" {
  project = var.project_id
  name    = "bizora_errors"
  filter  = "resource.type=\"cloud_run_revision\" AND (resource.labels.service_name=\"bizora-api\" OR resource.labels.service_name=\"bizora-web\") AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "errors_logged" {
  project               = var.project_id
  display_name          = "Bizora is logging errors"
  combiner              = "OR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "More than 10 errors logged in 10 minutes"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.errors.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"

      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  documentation {
    content   = "Errors are being logged by Bizora. Open Error Reporting to see which. See docs/runbooks/incidents.md."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "database_disk" {
  project               = var.project_id
  display_name          = "Bizora database disk is filling up"
  combiner              = "OR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "Database disk over 80% full"

    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.bizora.name}\" AND metric.type=\"cloudsql.googleapis.com/database/disk/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  documentation {
    content   = "The Cloud SQL disk is over 80% full. Cloud SQL grows it automatically only if storage auto-increase is on; check the instance and the largest tables (product photos)."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required]
}
