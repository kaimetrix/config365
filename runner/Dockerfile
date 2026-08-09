# ─── Config365 Runner Image ───────────────────────────────────────────────────
# Job execution container for Gitea Actions workflows.
# Based on PowerShell on Ubuntu 22.04; pre-installs the M365 modules needed
# by the graph-configs, backup, and maintenance scripts.
#
# Workflows run inside this image via the runner label:
#   ubuntu-latest → docker://config365-runner:latest

FROM mcr.microsoft.com/powershell:7.4-ubuntu-22.04

LABEL org.opencontainers.image.title="Config365 Runner"
LABEL org.opencontainers.image.description="Gitea Actions job container with PowerShell and M365 modules"

# Install git (needed by actions/checkout), curl, and other utilities
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Trust PSGallery and install M365 modules
# Split into separate RUN layers so Docker can cache them individually.
RUN pwsh -NonInteractive -Command \
    "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted"

RUN pwsh -NonInteractive -Command \
    "Install-Module Microsoft.Graph -Force -Scope AllUsers -ErrorAction Stop; \
     Write-Host 'Microsoft.Graph installed.'"

RUN pwsh -NonInteractive -Command \
    "Install-Module ExchangeOnlineManagement -RequiredVersion 3.5.1 -Force -Scope AllUsers -ErrorAction Stop; \
     Write-Host 'ExchangeOnlineManagement 3.5.1 installed.'"

# Verify key modules are importable
RUN pwsh -NonInteractive -Command \
    "Import-Module Microsoft.Graph.Authentication -ErrorAction Stop; \
     Import-Module ExchangeOnlineManagement -ErrorAction Stop; \
     Write-Host 'Module verification passed.'"

WORKDIR /workspace
