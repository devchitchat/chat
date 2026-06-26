#!/bin/bash
set -e
npm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
sed -i '' -e "s|local/chat-web:[0-9]*\.[0-9]*\.[0-9]*|local/chat-web:$VERSION|g" charts/web/templates/deployment.yaml
docker build -t local/chat-web:$VERSION .
docker save "local/chat-web:$VERSION" | limactl shell "${LIMA_INSTANCE:-k3s}" -- sudo k3s ctr images import -
