#!/bin/bash
# Generate .env file with DO Spaces credentials from Andy Core
set -e

ANDY_ROOT="/home/alexhillman/andy"
ENV_FILE="/home/alexhillman/drawbridge/.env"

echo "Fetching drawbridge-spaces credentials..."
CREDS=$(bun run "$ANDY_ROOT/scripts/get-credential.ts" drawbridge-spaces 2>/dev/null)

if [ -z "$CREDS" ] || [ "$CREDS" = "null" ]; then
  echo "Error: Failed to fetch drawbridge-spaces credential"
  exit 1
fi

ACCESS_KEY=$(echo "$CREDS" | jq -r '.access_key')
SECRET_KEY=$(echo "$CREDS" | jq -r '.secret_key')
BUCKET=$(echo "$CREDS" | jq -r '.bucket')
REGION=$(echo "$CREDS" | jq -r '.region')

cat > "$ENV_FILE" <<EOF
DO_SPACES_ACCESS_KEY=$ACCESS_KEY
DO_SPACES_SECRET_KEY=$SECRET_KEY
DO_SPACES_BUCKET=$BUCKET
DO_SPACES_REGION=$REGION
EOF

echo "Generated $ENV_FILE"
