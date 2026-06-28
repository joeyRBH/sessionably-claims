# ─────────────────────────────────────────────────────────────
# Network
# ─────────────────────────────────────────────────────────────

output "vpc_id" {
  description = "Dedicated Claimsub VPC ID."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs hosting RDS and the Lambdas."
  value       = aws_subnet.private[*].id
}

output "lambda_security_group_id" {
  description = "Security group attached to the auth Lambdas."
  value       = aws_security_group.lambda.id
}

output "rds_security_group_id" {
  description = "Security group attached to RDS (ingress 5432 from the Lambda SG only)."
  value       = aws_security_group.rds.id
}

# ─────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────

output "db_endpoint" {
  description = "RDS endpoint (host:port). Use to assemble DATABASE_URL out-of-band."
  value       = aws_db_instance.main.endpoint
}

output "db_address" {
  description = "RDS hostname."
  value       = aws_db_instance.main.address
}

output "db_name" {
  description = "Initial database name."
  value       = aws_db_instance.main.db_name
}

# ─────────────────────────────────────────────────────────────
# Lambda
# ─────────────────────────────────────────────────────────────

output "lambda_function_names" {
  description = "Map of handler key → Lambda function name."
  value       = { for k, fn in aws_lambda_function.auth : k => fn.function_name }
}

output "lambda_function_arns" {
  description = "Map of handler key → Lambda ARN."
  value       = { for k, fn in aws_lambda_function.auth : k => fn.arn }
}

output "lambda_exec_role_arn" {
  description = "Lambda execution role ARN."
  value       = aws_iam_role.lambda_exec.arn
}

# ─────────────────────────────────────────────────────────────
# API
# ─────────────────────────────────────────────────────────────

output "api_id" {
  description = "HTTP API (v2) ID."
  value       = aws_apigatewayv2_api.http.id
}

output "api_endpoint" {
  description = "Default HTTPS endpoint for the HTTP API. Use to smoke-test before the custom domain is live."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

# ─────────────────────────────────────────────────────────────
# SSM
# ─────────────────────────────────────────────────────────────

output "ssm_secure_parameter_names" {
  description = "Names of the SecureString parameters whose values must be set out-of-band."
  value       = [for p in aws_ssm_parameter.secure : p.name]
}

# ─────────────────────────────────────────────────────────────
# Custom domain (ACM + API Gateway)
# ─────────────────────────────────────────────────────────────

output "acm_certificate_arn" {
  description = "ARN of the requested ACM certificate for api.claimsub.com."
  value       = aws_acm_certificate.api.arn
}

output "acm_validation_records" {
  description = "DNS records to add MANUALLY at the DNS provider to validate the ACM cert (name/type/value)."
  value = [
    for dvo in aws_acm_certificate.api.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}

output "api_custom_domain_target" {
  description = "Regional API Gateway hostname to point api.claimsub.com at (CNAME/ALIAS). Null until create_api_custom_domain = true (Phase 2)."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name : null
}

output "api_custom_domain_hosted_zone_id" {
  description = "Hosted zone ID of the API Gateway regional endpoint (for a Route53 ALIAS record). Null until Phase 2."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].hosted_zone_id : null
}

# ─────────────────────────────────────────────────────────────
# Reddably custom domain (ACM + API Gateway)
# ─────────────────────────────────────────────────────────────

output "acm_certificate_arn_reddably" {
  description = "ARN of the requested ACM certificate for api.reddably.com."
  value       = aws_acm_certificate.api_reddably.arn
}

output "acm_validation_records_reddably" {
  description = "DNS records to add MANUALLY at the DNS provider to validate the Reddably ACM cert (name/type/value)."
  value = [
    for dvo in aws_acm_certificate.api_reddably.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}

output "api_custom_domain_target_reddably" {
  description = "Regional API Gateway hostname to point api.reddably.com at (CNAME/ALIAS). Null until create_api_custom_domain = true (Phase 2)."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api_reddably[0].domain_name_configuration[0].target_domain_name : null
}

output "api_custom_domain_hosted_zone_id_reddably" {
  description = "Hosted zone ID of the Reddably API Gateway regional endpoint (for a Route53 ALIAS record). Null until Phase 2."
  value       = var.create_api_custom_domain ? aws_apigatewayv2_domain_name.api_reddably[0].domain_name_configuration[0].hosted_zone_id : null
}
