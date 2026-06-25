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
