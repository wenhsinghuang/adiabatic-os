#!/usr/bin/env bash
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${REGION:-us-west-2}"
GITHUB_REPO="${GITHUB_REPO:-wenhsinghuang/adiabatic-os}"
ROLE_NAME="${ROLE_NAME:-LamarckCdkDeployRole}"
SECRET_PREFIX="${SECRET_PREFIX:-lamarck}"
CDK_QUALIFIER="${CDK_QUALIFIER:-hnb659fds}"
GITHUB_OIDC_THUMBPRINT="${GITHUB_OIDC_THUMBPRINT:-2b18947a6a9fc7764fd8b5fb18a863b0c6dac24f}"

OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
DEPLOY_ROLE_NAME="cdk-${CDK_QUALIFIER}-deploy-role-${ACCOUNT_ID}-${REGION}"
FILE_ROLE_NAME="cdk-${CDK_QUALIFIER}-file-publishing-role-${ACCOUNT_ID}-${REGION}"
EXEC_ROLE_NAME="cdk-${CDK_QUALIFIER}-cfn-exec-role-${ACCOUNT_ID}-${REGION}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "Account:      ${ACCOUNT_ID}"
echo "Region:       ${REGION}"
echo "GitHub repo:  ${GITHUB_REPO}"
echo "Deploy role:  ${ROLE_NAME}"
echo

echo "[1/5] Ensure GitHub Actions OIDC provider"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${OIDC_ARN}" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "${GITHUB_OIDC_THUMBPRINT}"
else
  echo "  - OIDC provider already exists: ${OIDC_ARN}"
fi

echo
echo "[2/5] Create/update ${ROLE_NAME}"
cat > /tmp/lamarck-trust-${ROLE_NAME}.json << EOF_TRUST
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${OIDC_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:*"
        }
      }
    }
  ]
}
EOF_TRUST

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document file:///tmp/lamarck-trust-${ROLE_NAME}.json
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document file:///tmp/lamarck-trust-${ROLE_NAME}.json
fi

cat > /tmp/lamarck-inline-${ROLE_NAME}.json << EOF_INLINE
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeCdkDeployRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOY_ROLE_NAME}"
    },
    {
      "Sid": "AllowPassCfnExecRoleToCloudFormation",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
    },
    {
      "Sid": "AllowSyncLamarckSecrets",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:TagResource"
      ],
      "Resource": [
        "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${SECRET_PREFIX}/dev/app*",
        "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${SECRET_PREFIX}/prod/app*"
      ]
    }
  ]
}
EOF_INLINE

aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "LamarckCdkDeployPolicy" \
  --policy-document file:///tmp/lamarck-inline-${ROLE_NAME}.json

aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess >/dev/null 2>&1 || true

aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AWSCloudFormationFullAccess >/dev/null 2>&1 || true

echo
echo "[3/5] Ensure CDK bootstrap roles exist"
for bootstrap_role in "${DEPLOY_ROLE_NAME}" "${FILE_ROLE_NAME}" "${EXEC_ROLE_NAME}"; do
  if ! aws iam get-role --role-name "${bootstrap_role}" >/dev/null 2>&1; then
    echo "Missing ${bootstrap_role}."
    echo "Run first:"
    echo "  cdk bootstrap aws://${ACCOUNT_ID}/${REGION} --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess"
    exit 1
  fi
done

echo
echo "[4/5] Update CDK bootstrap deploy/file role trust"
python3 - << PY
import json
import subprocess

account = "${ACCOUNT_ID}"
role_name = "${ROLE_NAME}"
deploy_role_name = "${DEPLOY_ROLE_NAME}"
file_role_name = "${FILE_ROLE_NAME}"
exec_role_name = "${EXEC_ROLE_NAME}"

def role_exists(name: str) -> bool:
    return subprocess.run(
        ["aws", "iam", "get-role", "--role-name", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0

project_roles = [role_name]
for optional in ["TrendJackerCdkDeployRole"]:
    if role_exists(optional):
        project_roles.append(optional)

project_role_arns = [f"arn:aws:iam::{account}:role/{name}" for name in project_roles]
root_arn = f"arn:aws:iam::{account}:root"
deploy_role_arn = f"arn:aws:iam::{account}:role/{deploy_role_name}"

deploy_trust = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowRootAndProjectDeployRolesToAssume",
            "Effect": "Allow",
            "Principal": {"AWS": project_role_arns + [root_arn]},
            "Action": "sts:AssumeRole",
            "Condition": {"Null": {"sts:ExternalId": "true"}},
        },
        {
            "Sid": "AllowCloudFormationToAssume",
            "Effect": "Allow",
            "Principal": {"Service": "cloudformation.amazonaws.com"},
            "Action": "sts:AssumeRole",
        },
        {
            "Sid": "AllowRootToTagSession",
            "Effect": "Allow",
            "Principal": {"AWS": root_arn},
            "Action": "sts:TagSession",
        },
    ],
}

file_trust = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowRootDeployAndProjectRolesToAssume",
            "Effect": "Allow",
            "Principal": {"AWS": [root_arn, deploy_role_arn] + project_role_arns},
            "Action": "sts:AssumeRole",
            "Condition": {"Null": {"sts:ExternalId": "true"}},
        },
        {
            "Sid": "AllowRootToTagSession",
            "Effect": "Allow",
            "Principal": {"AWS": root_arn},
            "Action": "sts:TagSession",
        },
    ],
}

with open("/tmp/lamarck-cdk-deploy-trust.json", "w") as f:
    json.dump(deploy_trust, f, indent=2)

with open("/tmp/lamarck-cdk-file-trust.json", "w") as f:
    json.dump(file_trust, f, indent=2)
PY

aws iam update-assume-role-policy \
  --role-name "${DEPLOY_ROLE_NAME}" \
  --policy-document file:///tmp/lamarck-cdk-deploy-trust.json

aws iam update-assume-role-policy \
  --role-name "${FILE_ROLE_NAME}" \
  --policy-document file:///tmp/lamarck-cdk-file-trust.json

cat > /tmp/lamarck-inline-AllowAssumeFilePublishingRole.json << EOF_DEPLOY_INLINE_1
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeFilePublishingRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${FILE_ROLE_NAME}"
    }
  ]
}
EOF_DEPLOY_INLINE_1

aws iam put-role-policy \
  --role-name "${DEPLOY_ROLE_NAME}" \
  --policy-name "AllowAssumeFilePublishingRole" \
  --policy-document file:///tmp/lamarck-inline-AllowAssumeFilePublishingRole.json

cat > /tmp/lamarck-inline-AllowPassSelfAndCfnExec.json << EOF_DEPLOY_INLINE_2
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPassSelfAndCfnExec",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOY_ROLE_NAME}",
        "arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}"
      ]
    }
  ]
}
EOF_DEPLOY_INLINE_2

aws iam put-role-policy \
  --role-name "${DEPLOY_ROLE_NAME}" \
  --policy-name "AllowPassSelfAndCfnExec" \
  --policy-document file:///tmp/lamarck-inline-AllowPassSelfAndCfnExec.json

echo
echo "[5/5] Ensure CFN exec role can deploy the CDK stack"
aws iam attach-role-policy \
  --role-name "${EXEC_ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess >/dev/null 2>&1 || true

echo
echo "Done. Lamarck IAM topology is configured."
echo "Role ARN: ${ROLE_ARN}"
