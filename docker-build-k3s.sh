#!/bin/bash
set -e
export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"
VERSION=$(git rev-parse --short HEAD)
sed -i '' -e "s|local/chat-web:[a-zA-Z0-9]*|local/chat-web:$VERSION|g" charts/web/templates/deployment.yaml
docker build --load -t local/chat-web:$VERSION .
docker save "local/chat-web:$VERSION" | limactl shell "${LIMA_INSTANCE:-k3s}" -- sudo k3s ctr images import -
