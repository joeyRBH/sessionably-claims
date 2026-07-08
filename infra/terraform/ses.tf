# =============================================================================
# SES - transactional email sending for reddably.com.
#
# Backs the admin notification emails (backend/lib/email.js) — currently the
# "a client completed intake" alert. We verify the reddably.com DOMAIN identity
# with DKIM so any FROM on the domain (e.g. notifications@reddably.com) can send.
#
# DNS is NOT managed here (no Route53 assumption): Terraform creates the identity
# and emits the DNS records to add MANUALLY at the domain's DNS provider (see the
# ses_* outputs). Until those records are added and AWS marks the domain
# verified, SendEmail throws — the app treats that as non-fatal (the intake
# request still succeeds; see backend/lib/email.js + card_setup.js).
#
# The sending permission (ses:SendEmail scoped to this identity) is granted to
# the Lambda execution role in iam.tf.
# =============================================================================

resource "aws_ses_domain_identity" "reddably" {
  domain = var.ses_domain
}

# Easy DKIM: three CNAME tokens to publish. DKIM-signing improves deliverability
# and, together with the identity, verifies the domain for sending.
resource "aws_ses_domain_dkim" "reddably" {
  domain = aws_ses_domain_identity.reddably.domain
}
