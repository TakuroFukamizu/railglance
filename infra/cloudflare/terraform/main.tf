terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # api_token is read from CLOUDFLARE_API_TOKEN environment variable
}

provider "aws" {
  region                      = "auto"
  access_key                  = var.r2_access_key_id
  secret_key                  = var.r2_secret_access_key
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true

  endpoints {
    s3 = "https://${var.account_id}.r2.cloudflarestorage.com"
  }
}

variable "account_id" {
  type        = string
  description = "Cloudflare Account ID"
}

variable "zone_id" {
  type        = string
  default     = ""
  description = "Optional Cloudflare Domain Zone ID. Leave empty until a custom domain is added; zone cache rules are skipped."

  validation {
    condition     = var.zone_id == "" || can(regex("^[0-9a-f]{32}$", var.zone_id))
    error_message = "zone_id must be empty or a 32-character lowercase hexadecimal Cloudflare Zone ID."
  }
}

variable "r2_access_key_id" {
  type        = string
  sensitive   = true
  description = "R2 S3-compatible Access Key ID"
}

variable "r2_secret_access_key" {
  type        = string
  sensitive   = true
  description = "R2 S3-compatible Secret Access Key"
}

variable "cors_allowed_origins" {
  type        = list(string)
  description = "Exact web application origins allowed to read public dataset objects"

  validation {
    condition     = length(var.cors_allowed_origins) > 0 && !contains(var.cors_allowed_origins, "*")
    error_message = "At least one exact CORS origin is required; wildcard is not allowed."
  }
}

# 1. Cloudflare R2 Bucket for Static Railway Dataset Tiles
resource "cloudflare_r2_bucket" "railway_dataset" {
  account_id = var.account_id
  name       = "railglance-dataset-bucket"
  location   = "APAC" # Asia Pacific
}

# Private diagnostic telemetry storage. Do not attach a public r2.dev URL or custom domain.
resource "cloudflare_r2_bucket" "diagnostic_telemetry" {
  account_id = var.account_id
  name       = "railglance-telemetry-bucket"
  location   = "APAC"
}

resource "aws_s3_bucket_cors_configuration" "railway_dataset" {
  bucket = cloudflare_r2_bucket.railway_dataset.name

  cors_rule {
    id              = "railglance-web-read"
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 86400
  }
}

# 2. Cache Rules for Versioned Datasets & Latest Pointer
resource "cloudflare_ruleset" "cache_rules" {
  count = var.zone_id == "" ? 0 : 1

  zone_id     = var.zone_id
  name        = "RailGlance Tile Cache Rules"
  description = "Long-term caching for versioned tiles and short TTL for latest.json"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules {
    action = "set_cache_settings"
    action_parameters {
      edge_ttl {
        mode    = "override_origin"
        default = 31536000 # 1 year for versioned tiles
      }
      browser_ttl {
        mode    = "override_origin"
        default = 31536000
      }
    }
    expression  = "http.request.uri.path matches \"^/datasets/v[0-9]+\\.\""
    description = "Cache versioned dataset tiles for 1 year immutable"
  }

  rules {
    action = "set_cache_settings"
    action_parameters {
      edge_ttl {
        mode    = "override_origin"
        default = 300 # 5 minutes for latest pointer
      }
      browser_ttl {
        mode    = "override_origin"
        default = 300
      }
    }
    expression  = "http.request.uri.path eq \"/datasets/latest.json\""
    description = "Short TTL for latest.json pointer"
  }
}
