variable "cloudflare_account_id" {
  description = "Cloudflare account identifier. Set with TF_VAR_cloudflare_account_id."
  type        = string
}

variable "worker_name" {
  description = "Worker script and service name."
  type        = string
  default     = "intern-notifs"
}

variable "public_api_url" {
  description = "Public HTTPS origin used for authenticated R2 upload and download URLs."
  type        = string
}

variable "api_hostname" {
  description = "Optional custom hostname, for example api.internnotifs.com."
  type        = string
  default     = null
  nullable    = true
}

variable "zone_id" {
  description = "Cloudflare zone identifier required when api_hostname is set."
  type        = string
  default     = null
  nullable    = true
}

variable "auth_dev_mode" {
  description = "Return verification codes in signup responses. Must be false outside development."
  type        = bool
  default     = false
}

variable "auth_from_email" {
  description = "Verified sender used for account verification and digest email."
  type        = string
  default     = null
  nullable    = true
}

variable "digest_to_email" {
  description = "Optional private digest recipient."
  type        = string
  default     = null
  nullable    = true
}

variable "ntfy_topic" {
  description = "Optional legacy ntfy topic."
  type        = string
  default     = null
  nullable    = true
}

variable "ntfy_endpoint" {
  description = "Optional legacy ntfy endpoint."
  type        = string
  default     = null
  nullable    = true
}

variable "gmail_enabled" {
  description = "Enables Gmail OAuth for approved test users only until restricted-scope verification is complete."
  type        = bool
  default     = false
}

variable "identity_unconfirmed_publication_enabled" {
  description = "Publishes and alerts admission-valid roles that do not yet have reviewed exact posting identity."
  type        = bool
  default     = false
}

variable "identity_confirmed_coverage_floor" {
  description = "Minimum reviewed exact posting-identity coverage required by the recurring integrity gate."
  type        = number
  default     = 1

  validation {
    condition     = var.identity_confirmed_coverage_floor >= 0 && var.identity_confirmed_coverage_floor <= 1
    error_message = "identity_confirmed_coverage_floor must be between 0 and 1."
  }
}

variable "gmail_client_id" {
  description = "Google OAuth web client identifier. The client secret remains a Worker secret binding."
  type        = string
  default     = null
  nullable    = true
}

variable "gmail_redirect_uri" {
  description = "Google OAuth callback URL, normally https://api.internnotifs.com/oauth/gmail/callback."
  type        = string
  default     = null
  nullable    = true
}

variable "admission_queue_age_alert_hours" {
  description = "Maximum destination-verification queue age before the Worker emits a deduplicated operational alert."
  type        = number
  default     = 120
}

variable "admission_stale_alert_threshold" {
  description = "Number of stale destination evidence records that triggers a deduplicated operational alert."
  type        = number
  default     = 1
}
