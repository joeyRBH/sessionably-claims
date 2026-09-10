// =============================================================================
// APPLY-MIGRATION - one-off, operator-invoked migration Lambda
// (claimsub-<env>-apply-migration).
//
// Runs backend/handlers/apply_migration.js from inside the VPC. RDS is
// publicly_accessible = false and there is no bastion, so this and the two
// Lambdas beside it (migrate.tf, backfill.tf) are the ONLY ways an operator can
// reach the real database. db/migrations/README.md previously told operators to
// use `psql -f` from "a bastion / tunnel" that has never existed; that gap is
// how migration 023 shipped in #116 with no way to apply it.
//
// Shaped exactly like backfill.tf: same role, same private subnets, same Lambda
// SG, DATABASE_URL read from SSM at RUNTIME so there is no out-of-band env
// hydration and no ignore_changes on environment.
//
// TWO DIFFERENCES FROM MIGRATE, BOTH ON PURPOSE:
//
//   * deploy.sh does NOT invoke this. migrate runs on every deploy because
//     applying an idempotent schema is safe; this one applies a NAMED migration
//     that may carry a data backfill, and must never run as a side effect of
//     shipping code.
//   * It is READ-ONLY by default. A bare invoke returns a status report and
//     writes nothing; only a payload naming a migration with a strict
//     {"apply": true} performs the migration.
//
//   # status (read-only):
//   aws lambda invoke --function-name $(terraform output -raw apply_migration_function_name) \
//     /tmp/migration.json && cat /tmp/migration.json
//
//   # apply one named migration:
//   aws lambda invoke --function-name $(terraform output -raw apply_migration_function_name) \
//     --payload '{"migration":"024_partner_claim_event_attribution","apply":true}' \
//     --cli-binary-format raw-in-base64-out \
//     /tmp/migration.json && cat /tmp/migration.json
//
// Repeated execution is guarded by a schema_migrations ledger (name + sha256,
// written in the same transaction as the DDL), a checksum refusal that force
// cannot override, and a session advisory lock. See the handler header.
//
// The handler ships in the same backend zip as every other function
// (archive_file.backend in lambda.tf covers backend/ wholesale), and the
// migration SQL rides along via `npm run bundle:schema`, so there is no extra
// build step. Timeout is 60s like migrate - it is invoked directly, never
// through API Gateway's 29s integration limit.
//
// Prefer folding an idempotent, backfill-free migration into db/schema.sql over
// invoking this. This is the exception path, not the default one.
// =============================================================================

resource "aws_cloudwatch_log_group" "apply_migration" {
  name              = "/aws/lambda/${local.prefix}-apply-migration"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "apply_migration" {
  function_name = "${local.prefix}-apply-migration"
  description   = "Claimsub one-off migration runner: applies ONE named file from db/migrations. Read-only status unless invoked with {migration:<name>, apply:true}. Never invoked by deploy.sh."

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = "handlers/apply_migration.handler"

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
    aws_cloudwatch_log_group.apply_migration,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_vpc_endpoint.ssm,
  ]
}
