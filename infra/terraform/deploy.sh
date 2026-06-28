#!/usr/bin/env bash
set -euo pipefail

# Claimsub deploy: terraform apply, then hydrate every Lambda's runtime config from
# SSM (decrypted) WITHOUT writing it to tfstate. Secrets live only in SSM and each
# function's env config. Run from infra/terraform on a machine with the claimsub-prod
# profile (or set AWS_PROFILE/AWS_REGION).
#
# Hydrated env vars (one set, applied to every function):
#   DATABASE_URL, JWT_SECRET                              (required — hard-fail if unset)
#   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY,            (patient billing — warn if unset,
#   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,                 still inert until set in SSM)
#   TWILIO_FROM_NUMBER, APP_BASE_URL
#
# DB_MASTER_PASSWORD is intentionally NOT injected — it is a db-apply input only.

cd "$(dirname "$0")"

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)"; exit 2; }

PROFILE="${AWS_PROFILE:-claimsub-prod}"
REGION="${AWS_REGION:-us-west-2}"
AWS=(aws --profile "$PROFILE" --region "$REGION")

echo ">> terraform apply"
terraform apply "$@"

echo ">> reading terraform outputs"
FUNCS=$(terraform output -json lambda_function_names | jq -r '.[]')

# Both SecureString and String parameters are injected into the Lambda env. (Both
# are read with --with-decryption; that is a no-op for plain String params.)
INJECT_NAMES=$(
  { terraform output -json ssm_secure_parameter_names; terraform output -json ssm_string_parameter_names; } \
    | jq -rs 'add | .[]'
)

echo ">> fetching runtime config from SSM (decrypted)"
VARS_JSON='{}'
for PARAM in $INJECT_NAMES; do
  KEY="${PARAM##*/}"
  # DB_MASTER_PASSWORD is a db-apply input, never a Lambda env var — skip it.
  [ "$KEY" = "DB_MASTER_PASSWORD" ] && continue

  VAL=$("${AWS[@]}" ssm get-parameter --name "$PARAM" --with-decryption --query 'Parameter.Value' --output text)

  case "$KEY" in
    DATABASE_URL|JWT_SECRET)
      case "$VAL" in
        ""|"set-out-of-band-see-README") echo "ERROR: $KEY not set in SSM yet."; exit 1 ;;
      esac
      ;;
    *)
      case "$VAL" in
        ""|"set-out-of-band-see-README")
          echo ">> WARNING: $KEY is still a placeholder in SSM — patient billing stays inert until it is set."
          continue
          ;;
      esac
      ;;
  esac

  VARS_JSON=$(printf '%s' "$VARS_JSON" | jq --arg k "$KEY" --arg v "$VAL" '. + {($k): $v}')
done

for FN in $FUNCS; do
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
  CUR=$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)
  if [ -z "$CUR" ] || [ "$CUR" = "null" ]; then CUR='{}'; fi

  # Idempotent: skip if every hydrated key/value is already present in the env.
  ALREADY=$(jq -n --argjson cur "$CUR" --argjson new "$VARS_JSON" '($cur + $new) == $cur')
  if [ "$ALREADY" = "true" ]; then
    echo ">> $FN already hydrated, skipping"
    continue
  fi

  echo ">> hydrating $FN"
  ENVJSON=$(jq -n --argjson cur "$CUR" --argjson new "$VARS_JSON" '{Variables: ($cur + $new)}')
  TMP=$(mktemp)
  printf '%s' "$ENVJSON" > "$TMP"
  "${AWS[@]}" lambda update-function-configuration --function-name "$FN" --environment "file://$TMP" >/dev/null
  rm -f "$TMP"
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
done

echo ">> done. Runtime config hydrated from SSM; tfstate contains no secret values."
