# Remote state for the isolated Claimsub stack.
#
# This bucket + lock table are NOT created by this configuration (chicken/egg:
# the backend must exist before `terraform init`). Create them ONCE, out-of-band,
# in the Claimsub AWS account before the first init - see README.md §Prerequisites.
#
# Backend config takes only literals (no variables/interpolation). If you run in
# a different account/region, override at init time with `-backend-config=...`
# instead of editing committed values.
terraform {
  backend "s3" {
    bucket         = "claimsub-terraform-state"
    key            = "claimsub/prod/terraform.tfstate"
    region         = "us-west-2"
    dynamodb_table = "claimsub-terraform-locks"
    encrypt        = true
  }
}
