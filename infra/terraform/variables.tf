# ─────────────────────────────────────────────────────────────
# Core identity
# ─────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "Primary AWS region for all regional resources. Must match backend.tf's region."
  type        = string
  default     = "us-west-2"
}

variable "project_name" {
  description = "Project identifier; prefixes resource names and the SSM namespace."
  type        = string
  default     = "claimsub"
}

variable "environment" {
  description = "Deployment environment (prod, staging, ...)."
  type        = string
  default     = "prod"
}

# ─────────────────────────────────────────────────────────────
# Network
# ─────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR for the dedicated Claimsub VPC. Isolated from the Sessionably stack."
  type        = string
  default     = "10.40.0.0/16"
}

variable "private_subnet_cidrs" {
  description = "Two private subnet CIDRs (one per AZ). No public subnets - app path has no internet egress."
  type        = list(string)
  default     = ["10.40.1.0/24", "10.40.2.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) == 2
    error_message = "Provide exactly two private subnet CIDRs (one per AZ)."
  }
}

variable "create_ssm_vpc_endpoint" {
  description = <<-EOT
    Create an SSM interface endpoint so in-VPC Lambdas can read SSM parameters at
    runtime with no NAT (used by the one-off migrate Lambda; see migrate.tf and
    vpc-endpoints.tf). Bills hourly per AZ - you may set false to destroy it once
    the schema has been applied.
  EOT
  type        = bool
  default     = true
}

# ─────────────────────────────────────────────────────────────
# Database (RDS PostgreSQL)
# ─────────────────────────────────────────────────────────────

variable "db_engine_version" {
  description = "RDS PostgreSQL major/minor version."
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Initial RDS storage (GiB)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB). Set equal to db_allocated_storage to disable autoscaling."
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Initial database created on the instance."
  type        = string
  default     = "claimsub"
}

variable "db_master_username" {
  description = "RDS master username. Not a secret, but never the app's runtime user."
  type        = string
  default     = "claimsub_admin"
}

variable "db_master_password" {
  description = <<-EOT
    RDS master password. Sourced from SSM out-of-band - NEVER hardcode or commit.
    Supply at db-apply time via an environment variable read from the SSM
    SecureString, e.g.:
      export TF_VAR_db_master_password="$(aws ssm get-parameter \
        --name /claimsub/prod/DB_MASTER_PASSWORD --with-decryption \
        --query Parameter.Value --output text)"
    See README.md §Secrets. There is intentionally no default.
  EOT
  type        = string
  sensitive   = true
}

variable "db_backup_retention_days" {
  description = "Automated backup retention window (days). Must be > 0 to keep backups on."
  type        = number
  default     = 14

  validation {
    condition     = var.db_backup_retention_days > 0
    error_message = "Automated backups must stay enabled (retention > 0) for HIPAA."
  }
}

variable "db_multi_az" {
  description = "Run RDS Multi-AZ (recommended for prod; doubles cost)."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Block accidental RDS deletion. Keep true for any environment holding PHI."
  type        = bool
  default     = true
}

variable "rds_kms_key_arn" {
  description = "Customer-managed KMS key ARN for RDS storage encryption. Empty string uses the default aws/rds key (still encrypted)."
  type        = string
  default     = ""
}

variable "db_apply_immediately" {
  description = "Apply RDS modifications immediately instead of in the next maintenance window."
  type        = bool
  default     = false
}

# ─────────────────────────────────────────────────────────────
# Lambda
# ─────────────────────────────────────────────────────────────

variable "lambda_runtime" {
  description = "Lambda runtime for the auth handlers."
  type        = string
  default     = "nodejs20.x"
}

variable "lambda_memory_mb" {
  description = "Memory (MB) per auth Lambda."
  type        = number
  default     = 512
}

variable "lambda_timeout_seconds" {
  description = "Timeout (s) per auth Lambda. Must stay under the API Gateway 29s integration cap."
  type        = number
  default     = 15
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for Lambda and API access logs."
  type        = number
  default     = 30
}

variable "logs_kms_key_arn" {
  description = "Optional CMK ARN to encrypt CloudWatch log groups. Empty string uses AWS-managed log encryption."
  type        = string
  default     = ""
}

# ─────────────────────────────────────────────────────────────
# API + custom domain
# ─────────────────────────────────────────────────────────────

variable "allowed_origins" {
  description = "CORS allow-list for the HTTP API. Locked to the two Claimsub browser origins."
  type        = list(string)
  default     = ["https://app.claimsub.com", "https://claimsub.com"]
}

variable "api_domain_name" {
  description = "Custom domain served by API Gateway."
  type        = string
  default     = "api.claimsub.com"
}

variable "create_api_custom_domain" {
  description = <<-EOT
    Two-phase gate for the custom domain. Leave false on the first apply: Terraform
    only REQUESTS the ACM cert and emits the DNS-validation records as outputs.
    After you add those records at the DNS provider and the cert reaches ISSUED,
    set true and re-apply to create the custom domain + base-path mapping. See
    README.md §DNS repoint.
  EOT
  type        = bool
  default     = false
}
