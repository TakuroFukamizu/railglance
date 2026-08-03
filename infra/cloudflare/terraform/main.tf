terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  # api_token is read from CLOUDFLARE_API_TOKEN environment variable
}

variable "zone_id" {
  type        = string
  description = "Cloudflare Domain Zone ID"
}

variable "domain_name" {
  type        = string
  default     = "data.railglance.example"
  description = "Custom domain for R2 data bucket"
}

# 1. Cloudflare R2 Bucket for Static Railway Dataset Tiles
resource "cloudflare_r2_bucket" "railway_dataset" {
  account_id = var.zone_id
  name       = "railglance-dataset-bucket"
  location   = "apac" # Asia Pacific (Tokyo)
}

# 2. Cache Rules for Versioned Datasets & Latest Pointer
resource "cloudflare_ruleset" "cache_rules" {
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
