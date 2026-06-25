#!/usr/bin/env bash
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${REGION:-us-west-2}"
ROLE_NAME="${ROLE_NAME:-LamarckCdkDeployRole}"
CDK_QUALIFIER="${CDK_QUALIFIER:-hnb659fds}"

OUT_FILE="lamarck-iam-topology-$(date +%Y%m%d-%H%M%S).txt"
DEPLOY_ROLE_NAME="cdk-${CDK_QUALIFIER}-deploy-role-${ACCOUNT_ID}-${REGION}"
FILE_ROLE_NAME="cdk-${CDK_QUALIFIER}-file-publishing-role-${ACCOUNT_ID}-${REGION}"
EXEC_ROLE_NAME="cdk-${CDK_QUALIFIER}-cfn-exec-role-${ACCOUNT_ID}-${REGION}"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

echo "Writing IAM topology to: ${OUT_FILE}"

{
  echo "============================"
  echo " Lamarck IAM Topology"
  echo " Account: ${ACCOUNT_ID}"
  echo " Region : ${REGION}"
  echo " Time   : $(date -Iseconds)"
  echo "============================"
  echo

  for role in "${ROLE_NAME}" "${DEPLOY_ROLE_NAME}" "${FILE_ROLE_NAME}" "${EXEC_ROLE_NAME}" "TrendJackerCdkDeployRole"; do
    echo "==================================================="
    echo "ROLE: ${role}"
    echo "==================================================="
    echo
    aws iam get-role --role-name "${role}" --output json 2>/dev/null || {
      echo "(role not found: ${role})"
      echo
      continue
    }
    echo
    echo "--- Inline Policies for ${role} ---"
    inline_policies="$(aws iam list-role-policies --role-name "${role}" --query 'PolicyNames' --output text 2>/dev/null || true)"
    if [ -n "${inline_policies}" ]; then
      for policy in ${inline_policies}; do
        echo
        echo "### Inline Policy: ${policy}"
        aws iam get-role-policy \
          --role-name "${role}" \
          --policy-name "${policy}" \
          --output json || echo "(failed to get inline policy ${policy} on ${role})"
      done
    else
      echo "(no inline policies)"
    fi
    echo
    echo "--- Attached Managed Policies for ${role} ---"
    aws iam list-attached-role-policies --role-name "${role}" --output json 2>/dev/null || true
    echo
  done

  echo "==================================================="
  echo "OIDC Provider: ${OIDC_ARN}"
  echo "==================================================="
  aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "${OIDC_ARN}" \
    --output json 2>/dev/null || echo "(OIDC provider not found)"
  echo

  echo "==================================================="
  echo "CDK Assets Bucket Policy"
  echo "==================================================="
  assets_bucket="cdk-${CDK_QUALIFIER}-assets-${ACCOUNT_ID}-${REGION}"
  aws s3api get-bucket-policy \
    --bucket "${assets_bucket}" \
    --output json 2>/dev/null || echo "(no bucket policy or bucket not found: ${assets_bucket})"
} > "${OUT_FILE}"

echo "Done. IAM topology saved to: ${OUT_FILE}"
