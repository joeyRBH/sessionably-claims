# =============================================================================
# INTAKE REMINDER - scheduled "finish your details" patient email
# (reddably-<env>-intake-reminder).
#
# Staff text a patient an intake link and we stamp clients.payment_link_sent_at.
# Nothing then watched whether the patient finished. A client who never fills the
# form just sits there, and the first anyone notices is a claim that will not
# submit — days later, on the biller's screen rather than the patient's. This
# emails the patient once, 24h after the link went out, if their insurance
# details are still missing.
#
# TWO SWITCHES, BOTH OFF BY DEFAULT. This is unattended outbound mail to
# PATIENTS across every practice on the platform. A wrong send cannot be recalled,
# and a patient who marks it as spam damages the SES domain reputation every other
# notification in this product depends on.
#
#   1. var.intake_reminder_enabled  (default false)
#      The EventBridge rule is created DISABLED. Nothing runs at all.
#
#   2. var.intake_reminder_dry_run  (default true)
#      Even once scheduled, the function resolves WHO would be emailed and logs
#      the client ids and a count. It mints no token, sends no mail, and writes
#      nothing.
#
# The order to turn this on is 1 then 2, not both at once. Run it scheduled and
# dry, read one run's output, confirm the list is who you would have chased by
# hand, and only then set dry_run = false.
#
# A THIRD, QUIETER SAFETY: the handler stamps clients.intake_reminder_sent_at
# on a successful send and skips anyone who has one, so even a misconfigured
# schedule (say, hourly) cannot mail the same patient twice.
#
# Follows the claim-status-poll.tf pattern: no API Gateway route, and
# DATABASE_URL / JWT_SECRET are read from SSM at RUNTIME, so deploy.sh's
# env-hydration loop (which walks the API functions) does not need to know about
# it. JWT_SECRET is needed to mint a FRESH card-setup token — the original link's
# 24h expiry means re-sending it would send the patient to a dead page.
#
# SES egress: the shared lambda_exec role already grants ses:SendEmail scoped to
# var.ses_from_address (iam.tf), and the NAT gateway (nat.tf) provides the HTTPS
# egress SES needs from inside the VPC. No new grant, no new endpoint.
# =============================================================================

resource "aws_cloudwatch_log_group" "intake_reminder" {
  name              = "/aws/lambda/${local.prefix}-intake-reminder"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

resource "aws_lambda_function" "intake_reminder" {
  function_name = "${local.prefix}-intake-reminder"
  description   = "Scheduled patient reminder to finish intake (demographics + insurance). DRY RUN unless INTAKE_REMINDER_DRY_RUN=false; schedule disabled unless intake_reminder_enabled."

  role    = aws_iam_role.lambda_exec.arn
  runtime = var.lambda_runtime
  handler = "handlers/intake_reminder.handler"

  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256

  memory_size = var.lambda_memory_mb
  # One SES call per patient, sequentially. Invoked by EventBridge, never through
  # API Gateway, so the 29s integration limit does not apply.
  # INTAKE_REMINDER_MAX_CLIENTS is what actually bounds a run.
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
      DATABASE_URL_SSM_PARAM = "${local.ssm_path_prefix}/DATABASE_URL"
      JWT_SECRET_SSM_PARAM   = "${local.ssm_path_prefix}/JWT_SECRET"

      # The safety switch. The handler treats any value other than "false" as
      # dry — an unset or misspelled value must not start sending mail to
      # patients.
      INTAKE_REMINDER_DRY_RUN = var.intake_reminder_dry_run ? "true" : "false"

      INTAKE_REMINDER_MAX_CLIENTS   = tostring(var.intake_reminder_max_clients)
      INTAKE_REMINDER_MIN_AGE_HOURS = tostring(var.intake_reminder_min_age_hours)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.intake_reminder,
    aws_iam_role_policy.lambda_runtime,
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_vpc_endpoint.ssm,
  ]

  tags = local.common_tags
}

# The schedule. Created DISABLED unless explicitly enabled, so merging and
# deploying this changes nothing about what runs.
#
# Once daily, not hourly: the reminder fires a fixed time after the link was
# sent, so a finer schedule buys nothing but a tighter window on a 24h delay —
# and multiplies the blast radius of a misconfiguration.
resource "aws_cloudwatch_event_rule" "intake_reminder" {
  name                = "${local.prefix}-intake-reminder"
  description         = "Scheduled patient intake reminder (disabled unless intake_reminder_enabled)."
  schedule_expression = var.intake_reminder_schedule
  state               = var.intake_reminder_enabled ? "ENABLED" : "DISABLED"

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "intake_reminder" {
  rule      = aws_cloudwatch_event_rule.intake_reminder.name
  target_id = "intake-reminder"
  arn       = aws_lambda_function.intake_reminder.arn
}

resource "aws_lambda_permission" "intake_reminder_events" {
  statement_id  = "AllowInvokeFromEventBridge-intake-reminder"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.intake_reminder.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.intake_reminder.arn
}
