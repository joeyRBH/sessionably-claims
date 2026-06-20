# =============================================================================
# MIGRATE - one-off schema-migration Lambda (claimsub-<env>-migrate).
#
# Applies db/schema.sql to the private RDS from inside the VPC, replacing the
# bastion path for bootstrapping the schema (see README §Apply the database
# schema). It is VPC-attached to the same private subnets + Lambda SG as the auth
# functions, but differs in two ways:
#
#   * It reads DATABASE_URL from SSM at RUNTIME (via the SSM interface endpoint in
#     vpc-endpoints.tf), so there is NO out-of-band env-hydration step and NO
#     ignore_changes on environment - Terraform fully manages its (non-secret) env.
#   * Its timeout is 60s (vs the 15s auth cap) - it is invoked directly, never
#     through API Gateway's 29s integration limit.
#
# schema.sql is bundled into the zip by `npm run bundle:schema` (copies
# db/schema.sql -> backend/sql/schema.sql) which MUST run before `terraform apply`,
# alongside `npm install --omit=dev`. db/schema.sql stays the single source of
# truth; the copy is gitignored. schema.sql is idempotent, so re-invoking is safe.
# =============================================================================

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/aws/lambda/${local.prefix}-migrate"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "migrate" {
  function_name = "${local.prefix}-migrate"
  description   = "Claimsub one-off schema migration: applies db/schema.sql to RDS. Idempotent; safe to re-invoke."

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = "handlers/migrate.handler"

  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256

  memory_size   = var.lambda_memory_mb
  timeout       = 60
  architectures = ["arm64"]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      NODE_ENV = "production"
      # Name of the SecureString to read at runtime. Not a secret; the value is
      # fetched via SSM and never stored in the function config.
      DATABASE_URL_SSM_PARAM = "${local.ssm_path_prefix}/DATABASE_URL"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.migrate,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_vpc_endpoint.ssm,
  ]
}
