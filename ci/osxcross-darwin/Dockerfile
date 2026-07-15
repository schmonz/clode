# De-risk image: osxcross toolchain (x86_64 + i386 apple-darwin10) baked with the
# phracker MacOSX10.6 SDK. Cached as a docker layer so engine-build iterations are
# fast (the ~20-min osxcross compile runs ONCE). Becomes ci/osxcross-darwin once
# proven + published to ghcr.io/schmonz, pinned by digest.
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      clang llvm-dev cmake ninja-build git patch python3 libssl-dev liblzma-dev \
      libxml2-dev zlib1g-dev libbz2-dev cpio file curl ca-certificates xz-utils \
      uuid-dev bzip2 make nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/tpoechtrager/osxcross.git /opt/osxcross
WORKDIR /opt/osxcross
RUN curl -fsSL -o tarballs/MacOSX10.6.sdk.tar.xz \
      https://github.com/phracker/MacOSX-SDKs/releases/download/11.3/MacOSX10.6.sdk.tar.xz \
    && echo "ad93f3e25c1ee71e457ced1a9c106c2e6741afb96252f259a5b7c625d1156fe8  tarballs/MacOSX10.6.sdk.tar.xz" | sha256sum -c - \
    && UNATTENDED=1 SDK_VERSION=10.6 ./build.sh \
    && rm -rf build tarballs
ENV PATH="/opt/osxcross/target/bin:${PATH}"
# Graft crt1.10.6.o: phracker's 10.6 SDK strips startup objects, but a pre-10.8
# target needs crt1.10.6.o — and built with -DADD_PROGRAM_VARS it supplies the
# `environ` / __progname / NXArg* program vars that mod_spawn_sync.c references
# (else the final link fails "Undefined symbols: _environ"). Same Csu-85 v3 recipe
# as .github/actions/build-leg, built here with the osxcross clang.
RUN SDKLIB=/opt/osxcross/target/SDK/MacOSX10.6.sdk/usr/lib \
    && curl -fsSL -o /tmp/csu.tar.gz https://github.com/apple-oss-distributions/Csu/archive/refs/tags/Csu-85.tar.gz \
    && echo "87a6bfb1030455e17128d5803e02815e35a1c8bd8bda7bd7f4141431a4d0eac6  /tmp/csu.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/csu.tar.gz -C /tmp \
    && x86_64-apple-darwin10-clang -r -arch x86_64 -Os -mmacosx-version-min=10.6 \
         -nostdlib -keep_private_externs /tmp/Csu-Csu-85/start.s /tmp/Csu-Csu-85/crt.c \
         -o "$SDKLIB/crt1.10.6.o" -DADD_PROGRAM_VARS \
    && test -f "$SDKLIB/crt1.10.6.o" \
    && rm -rf /tmp/csu.tar.gz /tmp/Csu-Csu-85
# i386 slice (darwin-x86, floor 10.4 / Tiger): osxcross MASTER refuses SDK <= 10.5
# ("Use 'osxcross-1.1' branch"), so the 10.4u SDK gets a SEPARATE legacy checkout
# in /opt/osxcross-legacy. 10.4u is fat (ppc/i386/ppc64/x86_64) and ships its own
# crt1.o, so no Csu graft. Produces the *-apple-darwin8 wrappers.
RUN git clone --branch osxcross-1.1 --depth 1 https://github.com/tpoechtrager/osxcross.git /opt/osxcross-legacy \
    && cd /opt/osxcross-legacy \
    && curl -fsSL -o tarballs/MacOSX10.4u.sdk.tar.xz \
         https://github.com/phracker/MacOSX-SDKs/releases/download/11.3/MacOSX10.4u.sdk.tar.xz \
    && echo "d28276ce6b0f14af30f3bfdc171f8ef4033652da593578568f8be189506c1021  tarballs/MacOSX10.4u.sdk.tar.xz" | sha256sum -c - \
    && UNATTENDED=1 ./build.sh \
    && rm -rf build tarballs
ENV PATH="/opt/osxcross-legacy/target/bin:${PATH}"
# Put the i386 static libgcc.a on the default sysroot lib path so a plain `-lgcc`
# resolves the 64-bit integer-division builtins (__divdi3/__moddi3/__udivdi3/
# __umoddi3) that 32-bit i386 needs — osxcross's clang links no compiler runtime
# for darwin i386, and the SDK ships libgcc.a only under the deep gcc/ subdir.
RUN ln -sf gcc/i686-apple-darwin9/4.0.1/libgcc.a \
      /opt/osxcross-legacy/target/SDK/MacOSX10.4u.sdk/usr/lib/libgcc.a
WORKDIR /work
