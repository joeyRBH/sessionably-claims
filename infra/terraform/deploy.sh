#!/usr/bin/env bash
set -euo pipefail

# Claimsub deploy: terraform apply, then hydrate every Lambda's DATABASE_URL and
# JWT_SECRET from SSM (SecureString, decrypted) WITHOUT writing them to tfstate.
# Secrets live only in SSM and each function's env config. Run from infra/terraform
# on a machine with the claimsub-prod profile (or set AWS_PROFILE/AWS_REGION).

cd "$(dirname "$0")"

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)"; exit 2; }

PROFILE="${AWS_PROFILE:-claimsub-prod}"
REGION="${AWS_REGION:-us-west-2}"
AWS=(aws --profile "$PROFILE" --region "$REGION")

echo ">> terraform apply"
terraform apply "$@"

echo ">> reading terraform outputs"
FUNCS=$(terraform output -json lambda_function_names | jq -r '.[]')
DB_PARAM=$(terraform output -json ssm_secure_parameter_names | jq -r '.[] | select(endswith("/DATABASE_URL"))')
JWT_PARAM=$(terraform output -json ssm_secure_parameter_names | jq -r '.[] | select(endswith("/JWT_SECRET"))')

echo ">> fetching secrets from SSM (decrypted)"
DB_VAL=$("${AWS[@]}" ssm get-parameter --name "$DB_PARAM" --with-decryption --query 'Parameter.Value' --output text)
JWT_VAL=$("${AWS[@]}" ssm get-parameter --name "$JWT_PARAM" --with-decryption --query 'Parameter.Value' --output text)

case "$DB_VAL" in ""|"set-out-of-band-see-README") echo "ERROR: DATABASE_URL not set in SSM yet."; exit 1;; esac
case "$JWT_VAL" in ""|"set-out-of-band-see-README") echo "ERROR: JWT_SECRET not set in SSM yet."; exit 1;; esac

for FN in $FUNCS; do
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
  CUR=$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)
  if [ -z "$CUR" ] || [ "$CUR" = "null" ]; then CUR='{}'; fi
  CUR_DB=$(printf '%s' "$CUR" | jq -r '.DATABASE_URL // ""')
  CUR_JWT=$(printf '%s' "$CUR" | jq -r '.JWT_SECRET // ""')
  if [ "$CUR_DB" = "$DB_VAL" ] && [ "$CUR_JWT" = "$JWT_VAL" ]; then
    echo ">> $FN already hydrated, skipping"
    continue
  fi
  echo ">> hydrating $FN"
  ENVJSON=$(printf '%s' "$CUR" | jq --arg db "$DB_VAL" --arg jwt "$JWT_VAL" '{Variables: (. + {DATABASE_URL:$db, JWT_SECRET:$jwt})}')
  TMP=$(mktemp)
  printf '%s' "$ENVJSON" > "$TMP"
  "${AWS[@]}" lambda update-function-configuration --function-name "$FN" --environment "file://$TMP" >/dev/null
  rm -f "$TMP"
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
done

echo ">> done. Secrets hydrated from SSM; tfstate contains no secret values."
