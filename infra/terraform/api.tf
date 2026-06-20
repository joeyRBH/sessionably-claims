# =============================================================================
# API - API Gateway HTTP API (v2) fronting the three auth Lambdas.
#
#   POST /register → register Lambda
#   POST /login    → login Lambda
#   GET  /me       → me Lambda
#
# CORS is enforced at the gateway and locked to the two Claimsub browser origins.
# Because cors_configuration handles OPTIONS preflight automatically, no OPTIONS
# routes are wired to Lambda. CloudWatch access logging is on for the stage.
# =============================================================================

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  description   = "Claimsub auth HTTP API (register/login/me)."
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins  = var.allowed_origins
    allow_methods  = ["GET", "POST", "OPTIONS"]
    allow_headers  = ["content-type", "authorization"]
    expose_headers = ["content-type"]
    max_age        = 300
  }
}

resource "aws_apigatewayv2_integration" "auth" {
  for_each = local.lambda_functions

  api_id           = aws_apigatewayv2_api.http.id
  integration_type = "AWS_PROXY"
  # HTTP API requires integration_method = POST regardless of the client method.
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.auth[each.key].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "auth" {
  for_each = local.lambda_functions

  api_id    = aws_apigatewayv2_api.http.id
  route_key = "${each.value.method} /${each.value.path}"
  target    = "integrations/${aws_apigatewayv2_integration.auth[each.key].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit   = 50
    throttling_rate_limit    = 100
    detailed_metrics_enabled = true
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      integrationErr = "$context.integration.error"
      integrationLat = "$context.integration.latency"
      sourceIp       = "$context.identity.sourceIp"
      userAgent      = "$context.identity.userAgent"
    })
  }
}

resource "aws_cloudwatch_log_group" "apigw_access" {
  name              = "/aws/apigateway/${local.prefix}-api/access"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn == "" ? null : var.logs_kms_key_arn
}

# Allow API Gateway to invoke each Lambda, scoped to that function's exact route.
resource "aws_lambda_permission" "apigw" {
  for_each = local.lambda_functions

  statement_id  = "AllowInvokeFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/${each.value.method}/${each.value.path}"
}
