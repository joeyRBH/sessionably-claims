locals {
  prefix = "${var.project_name}-${var.environment}"

  # SSM namespace for this stack's parameters. The Lambda execution role is
  # scoped to exactly this path (see iam.tf).
  ssm_path_prefix = "/${var.project_name}/${var.environment}"

  # Two private subnets, one per AZ (first two AZs in the region).
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # The API surface: one Lambda per handler. A handler may serve more than one
  # route (method + path) — e.g. the clients resource is a single Lambda routed
  # internally by method and the presence of an {id} path parameter.
  # `handler` matches backend/handlers/<name>.handler (the zip root is /backend).
  lambda_functions = {
    register = {
      handler = "handlers/register.handler"
      routes  = [{ method = "POST", path = "register" }]
    }
    login = {
      handler = "handlers/login.handler"
      routes  = [{ method = "POST", path = "login" }]
    }
    me = {
      handler = "handlers/me.handler"
      routes  = [{ method = "GET", path = "me" }]
    }
    clients = {
      handler = "handlers/clients.handler"
      routes = [
        { method = "POST", path = "clients" },
        { method = "GET", path = "clients" },
        { method = "GET", path = "clients/{id}" },
        { method = "PATCH", path = "clients/{id}" },
        { method = "DELETE", path = "clients/{id}" },
      ]
    }
    insurance_records = {
      handler = "handlers/insurance_records.handler"
      routes = [
        { method = "POST", path = "insurance-records" },
        { method = "GET", path = "insurance-records" },
        { method = "GET", path = "insurance-records/{id}" },
        { method = "PATCH", path = "insurance-records/{id}" },
        { method = "DELETE", path = "insurance-records/{id}" },
      ]
    }
    sessions = {
      handler = "handlers/sessions.handler"
      routes = [
        { method = "POST", path = "sessions" },
        { method = "GET", path = "sessions" },
        { method = "GET", path = "sessions/{id}" },
        { method = "PATCH", path = "sessions/{id}" },
        { method = "DELETE", path = "sessions/{id}" },
      ]
    }
    claims = {
      handler = "handlers/claims.handler"
      routes = [
        { method = "POST", path = "claims" },
        { method = "GET", path = "claims" },
        { method = "GET", path = "claims/{id}" },
        { method = "PATCH", path = "claims/{id}" },
        { method = "DELETE", path = "claims/{id}" },
        { method = "POST", path = "claims/{id}/submit" },
        { method = "POST", path = "claims/{id}/refresh" },
        { method = "POST", path = "claims/{id}/void" },
        { method = "GET", path = "claims/{id}/events" },
      ]
    }
    users = {
      handler = "handlers/users.handler"
      routes = [
        { method = "GET", path = "users" },
        { method = "GET", path = "users/{id}" },
        { method = "PATCH", path = "users/{id}" },
      ]
    }
    invitations = {
      handler = "handlers/invitations.handler"
      routes = [
        { method = "POST", path = "invitations" },
        { method = "GET", path = "invitations" },
        { method = "DELETE", path = "invitations/{id}" },
      ]
    }
    vob = {
      handler = "handlers/vob.handler"
      routes = [
        { method = "POST", path = "vob/check" },
      ]
    }
    subscription = {
      handler = "handlers/subscription.handler"
      # DB-only status route stays on the Lambda API. The Stripe-facing
      # /subscription/vob/activate lives on Vercel (api/vob-activate.js) — the VPC
      # Lambdas have no NAT egress to Stripe.
      routes = [
        { method = "GET", path = "subscription/status" },
      ]
    }

    # ── DB side of the /api Vercel functions ──────────────────────────────────
    # The Vercel functions have outbound egress (Stripe/Twilio) but cannot reach
    # the VPC-private RDS. These VPC Lambdas own the DB access; the Vercel adapters
    # call them over HTTPS and keep only the third-party call. See the handlers.
    card_setup = {
      handler = "handlers/card_setup.handler"
      routes = [
        { method = "POST", path = "card-setup/context" },
        { method = "POST", path = "card-setup/save-customer" },
        { method = "POST", path = "card-setup/save-payment-method" },
      ]
    }
    payment_link = {
      handler = "handlers/payment_link.handler"
      routes = [
        { method = "POST", path = "clients/{id}/payment-link" },
      ]
    }
    claim_fee = {
      handler = "handlers/claim_fee.handler"
      routes = [
        { method = "POST", path = "claims/{id}/charge-fee/context" },
        { method = "POST", path = "claims/{id}/charge-fee/record" },
      ]
    }
    vob_billing = {
      handler = "handlers/vob_billing.handler"
      # checkout-context is staff-authed (called by api/vob-activate.js); webhook is
      # Stripe-signature-authed and fully replaces api/vob-webhook.js (no egress needed).
      routes = [
        { method = "POST", path = "subscription/vob/checkout-context" },
        { method = "POST", path = "subscription/vob/webhook" },
      ]
    }
  }

  # Flatten lambda_functions into one entry per (function, route) pair, keyed by a
  # sanitized string. Routes/integration permissions for_each over this map.
  api_routes = merge([
    for fname, fn in local.lambda_functions : {
      for r in fn.routes :
      "${fname}-${r.method}-${replace(replace(replace(r.path, "/", "-"), "{", ""), "}", "")}" => {
        function = fname
        method   = r.method
        path     = r.path
      }
    }
  ]...)

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Stack       = "claimsub-backend"
    HIPAA       = "true"
  }
}
