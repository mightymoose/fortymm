#!/bin/sh

# Generated wrapper entry point, kept small so a clean checkout needs only a
# JDK; Gradle itself is fetched and checksum-verified by the wrapper.
APP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLASSPATH=$APP_HOME/gradle/wrapper/gradle-wrapper.jar

if [ -n "$JAVA_HOME" ]; then
    JAVA_EXE=$JAVA_HOME/bin/java
else
    JAVA_EXE=java
fi

exec "$JAVA_EXE" -classpath "$CLASSPATH" org.gradle.wrapper.GradleWrapperMain "$@"
