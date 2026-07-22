FROM ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90
ARG VP_VERSION=0.2.5
ARG VP_INSTALLER_COMMIT=b9acb2f716871ee506124d31ef152659e0c75674
ARG VP_INSTALLER_SHA256=58bb052c6a007e662e99667d65686251b16d6b39aa21155487da6d51280b3d54
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.vite-plus/bin:$PATH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /work
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg procps sudo && rm -rf /var/lib/apt/lists/*
COPY install.sh ./
RUN ./install.sh --dependencies-only --yes
RUN curl -fsSLo /tmp/install-vp.sh "https://raw.githubusercontent.com/voidzero-dev/vite-plus/${VP_INSTALLER_COMMIT}/packages/cli/install.sh" \
    && echo "${VP_INSTALLER_SHA256}  /tmp/install-vp.sh" | sha256sum --check --status \
    && CI=1 VP_NODE_MANAGER=no VP_VERSION="${VP_VERSION}" bash /tmp/install-vp.sh \
    && rm /tmp/install-vp.sh \
    && vp --version
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=1 vp install --frozen-lockfile
COPY . .
CMD ["bash", "tests/integration/run.sh"]
