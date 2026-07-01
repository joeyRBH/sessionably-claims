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

# Optional secret: hydrated only when its SSM parameter exists AND holds a real
# value (not the placeholder). Missing/placeholder → left as-is, so a stack without
# Stedi configured still deploys. (Stripe secrets live in Vercel env, not here.)
fetch_optional() {
  # $1 = parameter-name suffix (e.g. /STEDI_API_KEY)
  local PARAM VAL
  PARAM=$(terraform output -json ssm_secure_parameter_names | jq -r --arg s "$1" '.[] | select(endswith($s))')
  [ -z "$PARAM" ] && { printf ''; return; }
  VAL=$("${AWS[@]}" ssm get-parameter --name "$PARAM" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || printf '')
  case "$VAL" in ""|"set-out-of-band-see-README"|"set-out-of-band-from-ssm") printf '';; *) printf '%s' "$VAL";; esac
}

STEDI_VAL=$(fetch_optional "/STEDI_API_KEY")
[ -n "$STEDI_VAL" ] && echo ">> STEDI_API_KEY present in SSM; will hydrate" || echo ">> STEDI_API_KEY not set in SSM; skipping"

for FN in $FUNCS; do
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
  CUR=$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)
  if [ -z "$CUR" ] || [ "$CUR" = "null" ]; then CUR='{}'; fi
  CUR_DB=$(printf '%s' "$CUR" | jq -r '.DATABASE_URL // ""')
  CUR_JWT=$(printf '%s' "$CUR" | jq -r '.JWT_SECRET // ""')
  CUR_STEDI=$(printf '%s' "$CUR" | jq -r '.STEDI_API_KEY // ""')
  if [ "$CUR_DB" = "$DB_VAL" ] && [ "$CUR_JWT" = "$JWT_VAL" ] \
     && { [ -z "$STEDI_VAL" ] || [ "$CUR_STEDI" = "$STEDI_VAL" ]; }; then
    echo ">> $FN already hydrated, skipping"
    continue
  fi
  echo ">> hydrating $FN"
  # Merge db/jwt (required) plus stedi only when we have a real value.
  ENVJSON=$(printf '%s' "$CUR" | jq \
    --arg db "$DB_VAL" --arg jwt "$JWT_VAL" --arg stedi "$STEDI_VAL" '
      (. + {DATABASE_URL:$db, JWT_SECRET:$jwt})
      | (if $stedi != "" then . + {STEDI_API_KEY:$stedi} else . end)
      | {Variables: .}')
  TMP=$(mktemp)
  printf '%s' "$ENVJSON" > "$TMP"
  "${AWS[@]}" lambda update-function-configuration --function-name "$FN" --environment "file://$TMP" >/dev/null
  rm -f "$TMP"
  "${AWS[@]}" lambda wait function-updated --function-name "$FN"
done

echo ">> done. Secrets hydrated from SSM; tfstate contains no secret values."
