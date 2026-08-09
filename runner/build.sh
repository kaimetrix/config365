#!/usr/bin/env bash
# Build and pin the Config365 runner image.
# Run this script when updating module versions or scripts.
# Commit the updated digest to pipeline-templates/ after running.

set -euo pipefail

IMAGE_NAME="config365-runner"
TAG="latest"

echo "Building ${IMAGE_NAME}:${TAG}..."
docker build -t "${IMAGE_NAME}:${TAG}" .

DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_NAME}:${TAG}" 2>/dev/null || \
         docker inspect --format='{{.Id}}' "${IMAGE_NAME}:${TAG}")

echo ""
echo "Image built successfully."
echo "Digest: ${DIGEST}"
echo ""
echo "Update pipeline-templates/*.yml to reference:"
echo "  image: ${IMAGE_NAME}@${DIGEST}"
