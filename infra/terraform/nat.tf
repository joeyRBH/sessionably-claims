# =============================================================================
# NAT — outbound internet egress for the in-VPC Lambdas (HTTPS to Stedi).
#
# The app path was built with NO internet egress (see network.tf): no IGW, no
# NAT. That still holds for everything EXCEPT the clearinghouse calls. The VOB
# Lambda (handlers/vob.js) and claim submission (handlers/claims.js) must reach
# Stedi's public API (healthcare.us.stedi.com) over HTTPS. With no egress those
# fetches black-hole and the invocation stalls until the platform kills it
# (~10s of dead air → HTTP 502; this is the confirmed VOB-check failure mode).
#
# Why NAT and not a Vercel egress adapter (the pattern used for Stripe in /api):
# eligibility and claim payloads contain PHI, and Reddably's Vercel has no HIPAA
# BAA — so PHI must stay inside AWS. Egress therefore goes through an AWS-owned
# NAT Gateway here rather than out through Vercel. This also unblocks claim
# submission, which shares the exact same egress constraint.
#
# Shape: one public subnet + an Internet Gateway + a single NAT Gateway (with an
# Elastic IP). The existing private route table (network.tf) gains a
# 0.0.0.0/0 → NAT route, and the tight Lambda SG gains a 443 → internet egress
# rule. DNS resolution for the Lambda ENIs uses the in-VPC Amazon resolver and
# needs no egress. Gated by enable_nat_gateway so the recurring cost
# (~$35/month: NAT hourly + per-GB data processing) can be removed by setting the
# flag false (VOB / claim submission will 502 again until it is re-enabled).
# =============================================================================

resource "aws_internet_gateway" "main" {
  count = var.enable_nat_gateway ? 1 : 0

  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.prefix}-igw"
  }
}

# A single public subnet (first AZ) whose only job is to host the NAT Gateway.
# "Public" solely in that its route table points 0.0.0.0/0 at the IGW — no
# application resource is ever placed here, so it keeps map_public_ip_on_launch
# off (the NAT's Elastic IP provides the public address).
resource "aws_subnet" "public" {
  count = var.enable_nat_gateway ? 1 : 0

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidr
  availability_zone = local.azs[0]

  map_public_ip_on_launch = false

  tags = {
    Name = "${local.prefix}-public-${local.azs[0]}"
    Tier = "public"
  }
}

# Public route table: everything non-local egresses via the Internet Gateway.
resource "aws_route_table" "public" {
  count = var.enable_nat_gateway ? 1 : 0

  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.prefix}-public-rt"
  }
}

resource "aws_route" "public_igw" {
  count = var.enable_nat_gateway ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count = var.enable_nat_gateway ? 1 : 0

  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

# Stable public egress address for the NAT — the source IP Stedi (and any payer
# that allow-lists) sees.
resource "aws_eip" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  domain = "vpc"

  tags = {
    Name = "${local.prefix}-nat-eip"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  count = var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "${local.prefix}-nat"
  }

  depends_on = [aws_internet_gateway.main]
}

# Private subnets → NAT for all non-local traffic. Added to the EXISTING private
# route table (network.tf); both Lambda subnets inherit it through their existing
# association, so no per-subnet change is needed here.
resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? 1 : 0

  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

# Lambda → internet on HTTPS only. Without this the tight Lambda SG (network.tf /
# vpc-endpoints.tf) would still block outbound 443 even with the NAT route in
# place. Scoped to 443 so the Lambdas can reach HTTPS APIs (Stedi) and nothing
# else.
resource "aws_vpc_security_group_egress_rule" "lambda_to_internet_https" {
  count = var.enable_nat_gateway ? 1 : 0

  security_group_id = aws_security_group.lambda.id
  description       = "HTTPS to the internet (Stedi clearinghouse) via NAT"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}
