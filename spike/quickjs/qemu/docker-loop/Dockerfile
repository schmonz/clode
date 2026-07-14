# clode-sparc-ci — local iteration image for the netbsd-sparc cross-fuse leg.
# Runs qemu-system-sparc (TCG) under Linux/x86_64, matching ubuntu-latest, so
# the qemu-sun4m boot + ci-sparc-driver.py path can be walked in minutes locally
# instead of via GHA round-trips. The 8GB decompressed wd0.img is RAM-backed
# (--tmpfs) at run time; nothing here needs the tiny VM disk beyond the layers.
FROM debian:13

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      qemu-system-sparc qemu-utils \
      python3 python3-venv \
      zstd ca-certificates procps iproute2 \
 && rm -rf /var/lib/apt/lists/*

# anita + pexpect drive the guest over the serial console (PEP-668: use a venv).
# NB: the REAL anita (Andreas Gustafsson's NetBSD test tool) is on gson.org, NOT
# PyPI — `pip install anita` grabs an unrelated logic-proof teaching package
# (see RUNBOOK.md "DRIFT (wrong anita)"). Pin 2.18 to match the RUNBOOK.
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir \
      pexpect http://www.gson.org/netbsd/anita/download/anita-2.18.tar.gz \
 && /opt/venv/bin/python3 -c "import anita, pexpect"
ENV PATH=/opt/venv/bin:$PATH

CMD ["/bin/sh"]
