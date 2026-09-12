# =============================================================================
# CLAIM STATUS POLL - scheduled clearinghouse status check
# (claimsub-<env>-claim-status-poll).
#
# Nothing watched the clearinghouse. A claim's fate was learned only when a staff
# member clicked Refresh on that particular claim, so a practice that stopped
# clicking stopped finding out — including about denials the fee guarantee
# promises money back on.
#
# TWO SWITCHES, BOTH OFF BY DEFAULT. This is money-adjacent automation: an
# adjudicated denial raises a refund request an admin is then asked to approve.
#
#   1. var.claim_status_poll_enabled  (default false)
#      The EventBridge rule is created DISABLED. Nothing runs at all.
#
#   2. var.claim_status_poll_dry_run  (default true)
#      Even once scheduled, the function fetches real statuses and STORES the
#      verbatim payloads (claim_acknowledgments — exactly that table's stated
#      purpose) but writes nothing else: no status change, no claim_event, no
#      refund request. It logs what it WOULD have done.
#
# The order to turn this on is 1 then 2, not both at once. Run it scheduled and
# dry, read the payloads it collects, confirm denialClass() against a real 277
# denial — lib/clearinghouse/stedi.js says in its own header that its mappings
# "should be confirmed against a Stedi test account before going live" — and only
# then set dry_run = false.
#
# Follows the migrate.tf pattern rather than the API-Lambda one: it has no API
# Gateway route, and it reads DATABASE_URL / STEDI_API_KEY / CLEARINGHOUSE from
# SSM at RUNTIME, so deploy.sh's env-hydration loop (which walks the API
# functions) does not need to know about it.
# =============================================================================

resource "aws_cloudwatch_log_group" "claim_status_poll" {
  name              = "/aws/lambda/${local.prefix}-claim-status-poll"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "claim_status_poll" {
  function_name = "${local.prefix}-claim-status-poll"
  description   = "Scheduled clearinghouse claim-status check. DRY RUN unless CLAIM_POLL_DRY_RUN=false; schedule disabled unless claim_status_poll_enabled."

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = "handlers/claim_status_poll.handler"

  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256

  memory_size = var.lambda_memory_mb
  # Generous: it round-trips the clearinghouse once per claim, and the adapter
  # bounds each call at 15s. Invoked by EventBridge, never through API Gateway,
  # so the 29s integration limit does not apply. CLAIM_POLL_MAX_CLAIMS is what
  # actually bounds a run.
  timeout       = 300
  architectures = ["arm64"]

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      NODE_ENV = "production"
      # Names of parameters to read at runtime — not secrets themselves, and the
      # values never land in the function config or in tfstate.
      DATABASE_URL_SSM_PARAM  = "${local.ssm_path_prefix}/DATABASE_URL"
      STEDI_API_KEY_SSM_PARAM = "${local.ssm_path_prefix}/STEDI_API_KEY"
      CLEARINGHOUSE_SSM_PARAM = "${local.ssm_path_prefix}/CLEARINGHOUSE"

      # The safety switch. The handler treats ANY value other than the exact
      # string "false" as dry — an unset or misspelled value must not start
      # writing.
      CLAIM_POLL_DRY_RUN = var.claim_status_poll_dry_run ? "true" : "false"

      CLAIM_POLL_MAX_CLAIMS    = tostring(var.claim_status_poll_max_claims)
      CLAIM_POLL_MIN_AGE_HOURS = tostring(var.claim_status_poll_min_age_hours)
      CLAIM_POLL_RECHECK_HOURS = tostring(var.claim_status_poll_recheck_hours)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.claim_status_poll,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_vpc_endpoint.ssm,
  ]

  tags = local.common_tags
}

# The schedule. Created DISABLED unless explicitly enabled, so merging and
# deploying this changes nothing about what runs.
resource "aws_cloudwatch_event_rule" "claim_status_poll" {
  name                = "${local.prefix}-claim-status-poll"
  description         = "Scheduled clearinghouse claim-status check (disabled unless claim_status_poll_enabled)."
  schedule_expression = var.claim_status_poll_schedule
  state               = var.claim_status_poll_enabled ? "ENABLED" : "DISABLED"

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "claim_status_poll" {
  rule      = aws_cloudwatch_event_rule.claim_status_poll.name
  target_id = "claim-status-poll"
  arn       = aws_lambda_function.claim_status_poll.arn
}

resource "aws_lambda_permission" "claim_status_poll_events" {
  statement_id  = "AllowInvokeFromEventBridge-claim-status-poll"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.claim_status_poll.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.claim_status_poll.arn
}
