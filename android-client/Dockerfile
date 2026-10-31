# Builds and tests the Android client, so nothing Android or Java is installed
# on the host. Google ships aapt2 for x86-64 Linux only, so compose.yaml runs
# this image as linux/amd64. sdkmanager installs only the newest
# platform-tools, which AGP asks for.
FROM eclipse-temurin:21.0.13_9-jdk-noble

ARG GRADLE_VERSION=9.8.2
ARG CMDLINE_TOOLS_BUILD=16111833
ARG ANDROID_PLATFORM=android-37.0
ARG BUILD_TOOLS_VERSION=37.0.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
  && unzip -q /tmp/gradle.zip -d /opt \
  && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
  && rm /tmp/gradle.zip

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=/opt/gradle/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH

RUN curl -fsSL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip" \
  && mkdir -p "$ANDROID_HOME/cmdline-tools" \
  && unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools" \
  && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
  && rm /tmp/cmdline-tools.zip \
  && (yes | sdkmanager --licenses > /dev/null) \
  && sdkmanager --install platform-tools "platforms;${ANDROID_PLATFORM}" "build-tools;${BUILD_TOOLS_VERSION}" > /dev/null

WORKDIR /app/android-client
CMD ["gradle", "--version"]
