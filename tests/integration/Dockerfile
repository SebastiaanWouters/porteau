FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /work
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg procps sudo && rm -rf /var/lib/apt/lists/*
COPY install.sh ./
RUN ./install.sh --yes
RUN curl -fsSL https://vite.plus | CI=1 VP_NODE_MANAGER=yes bash
ENV PATH=/root/.vite-plus/bin:$PATH
COPY . .
RUN CI=1 vp install --frozen-lockfile
CMD ["bash", "tests/integration/run.sh"]
