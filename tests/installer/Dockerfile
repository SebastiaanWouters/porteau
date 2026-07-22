ARG UBUNTU_IMAGE=ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90
FROM ${UBUNTU_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
ENV TMPDIR=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends bats shellcheck ca-certificates curl gnupg sudo && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash porteau-test \
    && printf 'porteau-test ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/porteau-test \
    && chmod 0440 /etc/sudoers.d/porteau-test
WORKDIR /work
COPY --chown=porteau-test:porteau-test . .
USER porteau-test
CMD ["bash", "tests/installer/container-test.sh"]
