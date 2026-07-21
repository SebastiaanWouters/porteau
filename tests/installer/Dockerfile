ARG UBUNTU_IMAGE=ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90
FROM ${UBUNTU_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends bats shellcheck ca-certificates curl gnupg sudo && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . .
CMD ["bash", "tests/installer/container-test.sh"]
