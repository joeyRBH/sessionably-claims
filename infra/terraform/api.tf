# =============================================================================
# API - API Gateway HTTP API (v2) fronting the backend Lambdas.
#
#   POST   /register     → register Lambda
#   POST   /login        → login Lambda
#   GET    /me           → me Lambda
#   POST   /clients      → clients Lambda
#   GET    /clients      → clients Lambda
#   GET    /clients/{id} → clients Lambda
#   PATCH  /clients/{id} → clients Lambda
#   DELETE /clients/{id} → clients Lambda
#
# A single Lambda may serve several routes (see local.api_routes, which flattens
# local.lambda_functions into one entry per method+path). Routes and invoke
# permissions for_each over that map; the integration is still one per function.
#
# CORS is enforced at the gateway and locked to the two Claimsub browser origins.
# Because cors_configuration handles OPTIONS preflight automatically, no OPTIONS
# routes are wired to Lambda. CloudWatch access logging is on for the stage.
# =============================================================================

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  description   = "Claimsub HTTP API (auth + clients)."
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins  = var.allowed_origins
    allow_methods  = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
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
  for_each = local.api_routes

  api_id    = aws_apigatewayv2_api.http.id
  route_key = "${each.value.method} /${each.value.path}"
  target    = "integrations/${aws_apigatewayv2_integration.auth[each.value.function].id}"
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

# Allow API Gateway to invoke each Lambda, scoped to that route's exact method
# and path. One permission per route so a multi-route Lambda (e.g. clients) is
# reachable on every route key.
resource "aws_lambda_permission" "apigw" {
  for_each = local.api_routes

  statement_id  = "AllowInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth[each.value.function].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/${each.value.method}/${each.value.path}"
}
