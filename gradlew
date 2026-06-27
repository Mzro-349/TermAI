#!/bin/sh
APP_NAME="Gradle"
APP_BASE_NAME=`basename "$0"`
DEFAULT_JVM_OPTS="-Xmx64m -Xms64m"
MAX_FD="maximum"
warn () { echo "$*"; }
die () { echo; echo "$*"; echo; exit 1; }
OS="`uname`"
case "$OS" in Darwin*) os_type=Darwin ;; MINGW*) os_type=Windows ;; MSYS*) os_type=Windows ;; *) os_type=Linux ;; esac
PRG="$0"
while [ -h "$PRG" ] ; do ls=`ls -ld "$PRG"`; link=`expr "$ls" : '.*-> \(.*\)$'`; if expr "$link" : '/.*' > /dev/null; then PRG="$link"; else PRG=`dirname "$PRG"`"/$link"; fi; done
APP_HOME=`dirname "$PRG"`
classpath="$APP_HOME/gradle/wrapper/gradle-wrapper.jar"
java $DEFAULT_JVM_OPTS -classpath "$classpath" org.gradle.wrapper.GradleWrapperMain "$@"
