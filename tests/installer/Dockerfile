ARG UBUNTU_VERSION=24.04
FROM ubuntu:${UBUNTU_VERSION}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends bats shellcheck ca-certificates curl gnupg sudo && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . .
CMD ["bash", "tests/installer/container-test.sh"]
