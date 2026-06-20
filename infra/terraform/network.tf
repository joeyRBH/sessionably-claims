# =============================================================================
# NETWORK - dedicated, isolated VPC for the Claimsub stack.
#
# Design: there is NO internet path for the application. No Internet Gateway, no
# NAT Gateway. The auth Lambdas live in private subnets and only ever talk to
# RDS (5432). CloudWatch Logs delivery from a VPC Lambda does not traverse the
# function ENI, so logging works without egress. Lambda env vars are hydrated
# out-of-band (see ssm.tf / README), so the runtime never calls SSM either -
# hence no NAT and no interface endpoints are required for the app path. If a
# future handler needs runtime SSM/Secrets access, add VPC interface endpoints
# here (still no NAT).
# =============================================================================

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.prefix}-vpc"
  }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  # Never auto-assign public IPs - these subnets are private by construction.
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.prefix}-private-${local.azs[count.index]}"
    Tier = "private"
  }
}

# A single private route table with only the implicit local route (no 0.0.0.0/0).
# Associating it explicitly keeps the subnets off the VPC's default route table.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.prefix}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ─────────────────────────────────────────────────────────────
# Security groups
#
# Lambda SG  - egress ONLY to the RDS SG on 5432. No inbound. No internet egress.
# RDS SG     - inbound 5432 ONLY from the Lambda SG. No egress needed.
#
# Rules are split into individual aws_vpc_security_group_*_rule resources so plan
# diffs stay surgical and the SGs can reference each other without a cycle.
# ─────────────────────────────────────────────────────────────

resource "aws_security_group" "lambda" {
  name        = "${local.prefix}-lambda"
  description = "Claimsub auth Lambdas - egress to RDS only."
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.prefix}-lambda-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.prefix}-rds"
  description = "Claimsub RDS - Postgres ingress from the Lambda SG only."
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.prefix}-rds-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Lambda → RDS (the only egress the Lambdas have).
resource "aws_vpc_security_group_egress_rule" "lambda_to_rds" {
  security_group_id            = aws_security_group.lambda.id
  description                  = "Postgres to the Claimsub RDS SG"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

# RDS ← Lambda (the only ingress RDS accepts).
resource "aws_vpc_security_group_ingress_rule" "rds_from_lambda" {
  security_group_id            = aws_security_group.rds.id
  description                  = "Postgres from the Claimsub Lambda SG"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.lambda.id
}
