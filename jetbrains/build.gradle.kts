plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.3.0"
}

group = "com.catalystops"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        pycharmCommunity("2024.3")
        bundledPlugin("PythonCore")
    }
}

intellijPlatform {
    pluginConfiguration {
        id = "com.catalystops"
        name = "CatalystOps - PySpark Optimizer"
        version = "0.1.0"
        ideaVersion { sinceBuild = "243" }
    }
    publishing {
        token = providers.environmentVariable("JETBRAINS_TOKEN")
        // channels = listOf("beta")  // uncomment to publish to beta channel first
    }
}

// Use the system JDK (24) but target JVM 21 bytecode for IntelliJ compatibility
kotlin {
    jvmToolchain(24)
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.jvmTarget = "21"
}
tasks.withType<JavaCompile>().configureEach {
    sourceCompatibility = "21"
    targetCompatibility = "21"
}
