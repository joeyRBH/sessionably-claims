# =============================================================================
# SSM - SecureString parameters for the Lambda runtime secrets.
#
# These are declared WITHOUT real values: Terraform creates each parameter with a
# one-time placeholder, then `lifecycle.ignore_changes = [value]` makes Terraform
# stop managing the value entirely. Real values are set OUT-OF-BAND (see README
# §Secrets) and never enter code, tfvars, or the git-committed repo.
#
#   /claimsub/<env>/DATABASE_URL   postgres://USER:PASS@<rds-endpoint>:5432/claimsub
#   /claimsub/<env>/JWT_SECRET     HS256 signing secret (openssl rand -hex 32)
#
# Why SSM env-vars are then copied into the Lambda config rather than read at
# runtime: the existing /backend code reads process.env.DATABASE_URL /
# process.env.JWT_SECRET directly (do NOT modify /backend). So these SecureStrings
# are the canonical store, and the Lambda's environment is hydrated FROM them
# out-of-band (see lambda.tf + README). Granting the Lambda role ssm:GetParameter
# (iam.tf) keeps the door open for a future runtime fetch without code here.
#
# DB_MASTER_PASSWORD is also stored here as the canonical home for the RDS master
# password; it is read out-of-band into TF_VAR_db_master_password at db-apply
# time (see database.tf / README), so RDS never depends on this resource and the
# documented apply order (network → db → ssm → …) holds.
# =============================================================================

locals {
  # name → human description. Values are set out-of-band; never here.
  ssm_secure_parameters = {
    DATABASE_URL       = "Postgres connection string the auth Lambdas read as DATABASE_URL."
    JWT_SECRET         = "HS256 JWT signing secret the auth Lambdas read as JWT_SECRET."
    DB_MASTER_PASSWORD = "RDS master password (canonical home; read into TF_VAR at db-apply time)."
    STEDI_API_KEY      = "Stedi Healthcare API key the VOB (eligibility) + claims handlers read as STEDI_API_KEY."
  }
}

resource "aws_ssm_parameter" "secure" {
  for_each = local.ssm_secure_parameters

  name        = "${local.ssm_path_prefix}/${each.key}"
  description = each.value
  type        = "SecureString"

  # Placeholder only - real value is set out-of-band. ignore_changes below means
  # Terraform creates this once and never reads or overwrites the live value.
  value = "set-out-of-band-see-README"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name = each.key
  }
}
