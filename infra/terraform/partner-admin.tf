// =============================================================================
// PARTNER-ADMIN - operator-invoked partner-credential administration
// (claimsub-<env>-partner-admin).
//
// Runs backend/handlers/partner_admin.js from inside the VPC.
//
// backend/scripts/partner_credential.js is the real implementation and reaches
// the database through lib/db (DATABASE_URL). RDS is publicly_accessible =
// false, the account has no EC2 and nothing registered with SSM, and there is
// no bastion - so that script cannot be run against production from anywhere.
// It is correct code with no way to execute, exactly like migration 023 before
// apply-migration.tf existed.
//
// This is the third Lambda in that family (migrate.tf, backfill.tf,
// apply-migration.tf). Same role, same private subnets, same Lambda SG,
// DATABASE_URL read from SSM at RUNTIME so there is no out-of-band env
// hydration and no ignore_changes on environment.
//
// NOT invoked by deploy.sh, and never on a deploy. Issuing a credential is an
// operator decision, never a side effect of shipping code.
//
// READ-ONLY BY DEFAULT. A bare invoke returns counts. Every write mode is
// opted into by name, so an empty or mistyped payload cannot mutate anything.
//
//   # summary (read-only):
//   aws lambda invoke --function-name $(terraform output -raw partner_admin_function_name) \
//     /tmp/pa.json && cat /tmp/pa.json
//
//   # resolve ONE user's ids for linking (read-only):
//   aws lambda invoke --function-name $(terraform output -raw partner_admin_function_name) \
//     --payload '{"resolve":{"email":"someone@example.com"}}' \
//     --cli-binary-format raw-in-base64-out /tmp/pa.json && cat /tmp/pa.json
//
//   # issue (WRITES; returns the credential ONCE):
//   aws lambda invoke --function-name $(terraform output -raw partner_admin_function_name) \
//     --payload '{"issue":{"practice_id":"<uuid>","scopes":["clients:read"],"label":"pilot"}}' \
//     --cli-binary-format raw-in-base64-out /tmp/pa.json
//
// THE RESPONSE OF AN `issue` CALL CONTAINS THE PLAINTEXT CREDENTIAL. It is the
// only time that value exists outside the caller's memory - only its scrypt
// digest is stored, and the handler logs the key_id alone, never the secret.
// Pipe the response straight into the consuming system's secret manager rather
// than letting it land in a terminal or a file.
//
// The handler ships in the same backend zip as every other function
// (archive_file.backend in lambda.tf covers backend/ wholesale), so there is no
// extra build step. Timeout is 60s like its siblings - invoked directly, never
// through API Gateway's 29s integration limit.
// =============================================================================

resource "aws_cloudwatch_log_group" "partner_admin" {
  name              = "/aws/lambda/${local.prefix}-partner-admin"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "partner_admin" {
  function_name = "${local.prefix}-partner-admin"
  description   = "Claimsub operator tool: resolve a user's ids, list/issue/revoke partner credentials. Read-only unless a write mode is named in the payload. Never invoked by deploy.sh."

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = "handlers/partner_admin.handler"

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
    aws_cloudwatch_log_group.partner_admin,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_vpc_endpoint.ssm,
  ]
}
