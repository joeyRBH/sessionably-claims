# =============================================================================
# DATABASE - RDS PostgreSQL 16 in the private subnets.
#
# HIPAA posture: storage_encrypted = true, publicly_accessible = false, automated
# backups on, deletion protection on. The instance is reachable only from the
# Lambda SG (see network.tf).
#
# Master credentials: the username is a plain variable; the password is a
# sensitive variable sourced from SSM out-of-band at apply time (never hardcoded,
# never committed). See README.md §Secrets.
# =============================================================================

resource "aws_db_subnet_group" "main" {
  name        = "${local.prefix}-db"
  description = "Claimsub RDS subnet group (private subnets only)."
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.prefix}-db-subnet-group"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.prefix}-db"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_master_username
  password = var.db_master_password
  port     = 5432

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"

  # HIPAA: encrypt at rest. Empty CMK var → default aws/rds key (still encrypted).
  storage_encrypted = true
  kms_key_id        = var.rds_kms_key_arn == "" ? null : var.rds_kms_key_arn

  # Private placement.
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  # Backups / maintenance.
  backup_retention_period    = var.db_backup_retention_days
  backup_window              = "07:00-08:00"
  maintenance_window         = "Sun:08:30-Sun:09:30"
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true

  # Safety.
  deletion_protection       = var.db_deletion_protection
  apply_immediately         = var.db_apply_immediately
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.prefix}-db-final"

  # Surface Postgres logs to CloudWatch for audit/debugging (no PHI in these logs).
  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = {
    Name = "${local.prefix}-db"
  }
}
