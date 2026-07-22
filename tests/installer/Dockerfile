# syntax=docker/dockerfile:1
ARG UBUNTU_IMAGE=ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90
FROM ${UBUNTU_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
ENV TMPDIR=/tmp
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends bats shellcheck ca-certificates curl gnupg sudo
RUN useradd --create-home --shell /bin/bash porteau-test \
    && printf 'porteau-test ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/porteau-test \
    && chmod 0440 /etc/sudoers.d/porteau-test
# Real dependency install is exercised here so rebuilds (and GHA layer cache) pay the
# NodeSource/mydumper cost only when install.sh changes — not on every code edit.
COPY install.sh /tmp/porteau-install.sh
RUN bash /tmp/porteau-install.sh --dependencies-only --yes \
    && rm /tmp/porteau-install.sh
WORKDIR /work
USER porteau-test
CMD ["bash", "tests/installer/container-test.sh"]
