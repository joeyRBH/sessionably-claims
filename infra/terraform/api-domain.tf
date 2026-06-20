# =============================================================================
# CUSTOM DOMAIN - api.claimsub.com, modeled in two phases.
#
# Terraform REQUESTS a DNS-validated ACM cert and (once gated on) creates the API
# Gateway custom domain + base-path mapping. It does NOT manage any DNS records:
# the registrar/Route53 records (ACM validation CNAMEs and the api.claimsub.com →
# API Gateway alias/CNAME) are added MANUALLY by Joey. See README §DNS repoint.
#
# Phase 1 (create_api_custom_domain = false, default):
#   - The ACM cert is requested (status PENDING_VALIDATION).
#   - `acm_validation_records` output lists the CNAME(s) to add at the DNS provider.
#   - No custom domain yet (creating one needs an ISSUED cert).
#
# Phase 2 (create_api_custom_domain = true), after the cert reaches ISSUED:
#   - The custom domain + base-path mapping are created.
#   - `api_custom_domain_target` output gives the hostname to point
#     api.claimsub.com at. Joey adds that DNS record and removes the
#     api.claimsub.com record from Vercel.
# =============================================================================

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${local.prefix}-api-cert"
  }
}

resource "aws_apigatewayv2_domain_name" "api" {
  count = var.create_api_custom_domain ? 1 : 0

  domain_name = var.api_domain_name

  domain_name_configuration {
    # Reference the cert ARN directly. Apply Phase 2 only after the cert is
    # ISSUED (validated via the manually-added DNS records); otherwise this
    # resource fails because the cert is still pending.
    certificate_arn = aws_acm_certificate.api.arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = {
    Name = "${local.prefix}-api-domain"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  count = var.create_api_custom_domain ? 1 : 0

  api_id      = aws_apigatewayv2_api.http.id
  domain_name = aws_apigatewayv2_domain_name.api[0].id
  stage       = aws_apigatewayv2_stage.default.id
}
