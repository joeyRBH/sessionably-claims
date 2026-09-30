# Safety gate for `terraform show -json <planfile>` — used by deploy.sh.
#
# Reads ONLY resource addresses, types and action lists. Never touches
# before/after values: a plan JSON carries sensitive values in the clear.
#
#   jq -f plan_gate.jq --argjson allow_infra false plan.json
#
# Emits {counts, changes, violations, ok}. deploy.sh exits non-zero when
# ok is false.
#
# Rules
#   1. Any resource that would be DELETED or REPLACED (actions contain "delete")
#      is a violation, always. There is no override: destroying or replacing
#      RDS, a VPC, a Lambda, etc. is done by hand with terraform, not by deploy.sh.
#   2. A create/update of a protected infrastructure type is a violation unless
#      allow_infra is true (ALLOW_INFRA_CHANGE=1). A routine backend deploy only
#      updates aws_lambda_function.* and friends in place.

def protected_type:
  test("^(aws_db_|aws_rds_|aws_ssm_parameter|aws_vpc|aws_subnet|aws_security_group|aws_route|aws_nat_|aws_internet_gateway|aws_eip|aws_iam_|aws_kms_|aws_s3_bucket|aws_ses_|aws_acm_|aws_apigatewayv2_domain_name|aws_apigatewayv2_api_mapping)");

def kind:
  (.change.actions // []) as $a
  | if ($a | index("delete")) then
      (if ($a | index("create")) then "replace" else "delete" end)
    elif ($a | index("create")) then "create"
    elif ($a | index("update")) then "update"
    else "no-op" end;

($allow_infra // false) as $allow
| [ (.resource_changes // [])[]
    | {address, type, action: kind}
    | select(.action != "no-op") ] as $changes
| [ $changes[]
    | select(.action == "delete" or .action == "replace")
    | "\(.action | ascii_upcase) not allowed: \(.address)" ] as $destructive
| [ $changes[]
    | select((.action == "create" or .action == "update") and (.type | protected_type) and ($allow | not))
    | "infrastructure \(.action) needs ALLOW_INFRA_CHANGE=1: \(.address)" ] as $infra
| ($destructive + $infra) as $violations
| { counts: ($changes | group_by(.action) | map({key: .[0].action, value: length}) | from_entries),
    changes: $changes,
    violations: $violations,
    ok: ($violations | length == 0) }
