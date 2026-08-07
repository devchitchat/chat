#!/bin/bash
set -e

DOCKER_IMAGE_NAME='local/chat-web'
export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"
HEAD=$(git rev-parse --short HEAD)
DEPLOYED=$(grep -o "$DOCKER_IMAGE_NAME:[a-zA-Z0-9._-]*" charts/web/templates/deployment.yaml | head -1 | cut -d: -f2)
if [ "$HEAD" != "$DEPLOYED" ]; then
  VERSION=$HEAD
else
  VERSION=$(date +%s)
fi
sed -i '' -e "s|$DOCKER_IMAGE_NAME:[a-zA-Z0-9._-]*|$DOCKER_IMAGE_NAME:$VERSION|g" charts/web/templates/deployment.yaml
docker build --load -t $DOCKER_IMAGE_NAME:$VERSION .
docker save "$DOCKER_IMAGE_NAME:$VERSION" | limactl shell "${LIMA_INSTANCE:-k3s}" -- sudo k3s ctr images import -