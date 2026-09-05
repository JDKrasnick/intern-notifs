locals {
  worker_bundle       = "${path.module}/../../cloudflare/dist/worker.js"
  catalog_providers   = toset(["greenhouse", "lever", "ashby", "github"])
  asynchronous_queues = setunion(local.catalog_providers, toset(["gmail"]))
  plain_bindings = concat(
    [
      { name = "PUBLIC_API_URL", type = "plain_text", text = var.public_api_url },
      { name = "AUTH_DEV_MODE", type = "plain_text", text = tostring(var.auth_dev_mode) },
      { name = "GMAIL_ENABLED", type = "plain_text", text = tostring(var.gmail_enabled) },
      { name = "IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED", type = "plain_text", text = tostring(var.identity_unconfirmed_publication_enabled) },
      { name = "TRUSTED_COMMUNITY_CATALOG_ENABLED", type = "plain_text", text = tostring(var.trusted_community_catalog_enabled) },
      { name = "IDENTITY_CONFIRMED_COVERAGE_FLOOR", type = "plain_text", text = tostring(var.identity_confirmed_coverage_floor) },
    ],
    var.auth_from_email == null ? [] : [{ name = "AUTH_FROM_EMAIL", type = "plain_text", text = var.auth_from_email }],
    var.digest_to_email == null ? [] : [{ name = "DIGEST_TO_EMAIL", type = "plain_text", text = var.digest_to_email }],
    var.ntfy_topic == null ? [] : [{ name = "NTFY_TOPIC", type = "plain_text", text = var.ntfy_topic }],
    var.ntfy_endpoint == null ? [] : [{ name = "NTFY_ENDPOINT", type = "plain_text", text = var.ntfy_endpoint }],
    var.gmail_client_id == null ? [] : [{ name = "GMAIL_CLIENT_ID", type = "plain_text", text = var.gmail_client_id }],
    var.gmail_redirect_uri == null ? [] : [{ name = "GMAIL_REDIRECT_URI", type = "plain_text", text = var.gmail_redirect_uri }],
  )
}

resource "cloudflare_d1_database" "application" {
  account_id            = var.cloudflare_account_id
  name                  = "${var.worker_name}-db"
  primary_location_hint = "wnam"
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "documents" {
  account_id    = var.cloudflare_account_id
  name          = "${var.worker_name}-documents"
  location      = "WNAM"
  storage_class = "Standard"
}

resource "cloudflare_queue" "work" {
  for_each   = local.asynchronous_queues
  account_id = var.cloudflare_account_id
  queue_name = "${var.worker_name}-${each.key}"
  settings = {
    message_retention_period = 86400
    delivery_paused          = false
  }
}

resource "cloudflare_queue" "dead_letter" {
  for_each   = local.asynchronous_queues
  account_id = var.cloudflare_account_id
  queue_name = "${var.worker_name}-${each.key}-dlq"
  settings = {
    message_retention_period = 1209600
  }
}

resource "cloudflare_workers_script" "application" {
  account_id          = var.cloudflare_account_id
  script_name         = var.worker_name
  main_module         = "worker.js"
  content_file        = local.worker_bundle
  content_sha256      = filesha256(local.worker_bundle)
  compatibility_date  = "2026-08-26"
  compatibility_flags = ["nodejs_compat"]
  keep_bindings       = ["secret_text"]

  bindings = concat(
    [
      { name = "DB", type = "d1", id = cloudflare_d1_database.application.id },
      { name = "DOCUMENTS", type = "r2_bucket", bucket_name = cloudflare_r2_bucket.documents.name },
      { name = "GMAIL_QUEUE", type = "queue", queue_name = cloudflare_queue.work["gmail"].queue_name },
      { name = "GMAIL_DLQ", type = "queue", queue_name = cloudflare_queue.dead_letter["gmail"].queue_name },
      { name = "CLOUDFLARE_ACCOUNT_ID", type = "plain_text", text = var.cloudflare_account_id },
      { name = "WORKER_NAME", type = "plain_text", text = var.worker_name },
      { name = "GMAIL_QUEUE_ID", type = "plain_text", text = cloudflare_queue.work["gmail"].queue_id },
    ],
    [for provider in local.catalog_providers : {
      name       = "${upper(provider)}_QUEUE"
      type       = "queue"
      queue_name = cloudflare_queue.work[provider].queue_name
    }],
    [for provider in local.catalog_providers : {
      name       = "${upper(provider)}_DLQ"
      type       = "queue"
      queue_name = cloudflare_queue.dead_letter[provider].queue_name
    }],
    [for provider in local.catalog_providers : {
      name = "${upper(provider)}_QUEUE_ID"
      type = "plain_text"
      text = cloudflare_queue.work[provider].queue_id
    }],
    local.plain_bindings,
  )

  limits = {
    cpu_ms      = 30000
    subrequests = 10000
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      invocation_logs    = true
      head_sampling_rate = 1
      persist            = true
    }
  }
}

resource "cloudflare_workers_script_subdomain" "application" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.application.script_name
  enabled          = true
  previews_enabled = false
}

resource "cloudflare_queue_consumer" "application" {
  for_each          = cloudflare_queue.work
  account_id        = var.cloudflare_account_id
  queue_id          = each.value.queue_id
  type              = "worker"
  script_name       = cloudflare_workers_script.application.script_name
  dead_letter_queue = cloudflare_queue.dead_letter[each.key].queue_name
  settings = {
    batch_size = 1
    # The high-volume ingestion fleets get two consumers. Gmail stays at one
    # because per-account leases serialize sync work.
    max_concurrency  = contains(["greenhouse", "github"], each.key) ? 2 : 1
    max_retries      = each.key == "gmail" ? 5 : 2
    max_wait_time_ms = 5000
  }
}

resource "cloudflare_workers_cron_trigger" "application" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.application.script_name
  schedules = [
    { cron = "*/5 * * * *" },
    { cron = "7-57/10 * * * *" },
    { cron = "9-59/10 * * * *" },
    { cron = "12,42 * * * *" },
    { cron = "22,52 * * * *" },
    { cron = "2,32 * * * *" },
    { cron = "0 * * * *" },
    { cron = "42 8 * * *" },
    { cron = "17 9 * * *" },
  ]
}

resource "cloudflare_workers_custom_domain" "api" {
  count      = var.api_hostname == null ? 0 : 1
  account_id = var.cloudflare_account_id
  service    = cloudflare_workers_script.application.script_name
  hostname   = var.api_hostname
  zone_id    = var.zone_id

  lifecycle {
    precondition {
      condition     = var.zone_id != null
      error_message = "zone_id is required when api_hostname is set."
    }
  }
}
