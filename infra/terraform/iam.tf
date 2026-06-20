# =============================================================================
# IAM - least-privilege execution role shared by the three auth Lambdas.
#
# Permissions, scoped as tightly as the services allow:
#   * VPC ENI management + CloudWatch Logs baseline (AWS managed policy).
#   * ssm:GetParameter* on ONLY this stack's /claimsub/<env>/* namespace.
#   * kms:Decrypt limited to the SSM CMK, and only when one is configured.
# =============================================================================

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name                 = "${local.prefix}-lambda-exec"
  description          = "Execution role for the Claimsub auth Lambdas (register/login/me)."
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  max_session_duration = 3600
}

# ENI create/describe/delete for VPC attachment + base CloudWatch Logs perms.
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_runtime" {
  # SSM Parameter Store - read this stack's parameters only.
  statement {
    sid = "SSMReadClaimsubParams"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path_prefix}/*",
    ]
  }

  # KMS decrypt for SecureString parameters - only when a CMK is configured.
  # (Default SecureStrings use the AWS-managed aws/ssm key, which the parameter
  # owner can decrypt without an explicit grant.)
  dynamic "statement" {
    for_each = var.logs_kms_key_arn == "" ? [] : [var.logs_kms_key_arn]
    content {
      sid       = "KMSDecryptForSSM"
      actions   = ["kms:Decrypt", "kms:DescribeKey"]
      resources = [statement.value]
    }
  }

  # Explicit CloudWatch Logs for this stack's log groups. AWSLambdaVPCAccessExecutionRole
  # already grants these account-wide; restating them scoped keeps the role auditable.
  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.prefix}-*:*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda_runtime" {
  name   = "${local.prefix}-lambda-runtime"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_runtime.json
}
