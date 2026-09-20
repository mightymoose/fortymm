import java.util.zip.ZipFile

fun buildConfigString(value: String) = "\"${value.replace("\"", "\\\"")}\""

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.fortymm.android"
    compileSdk = 36

    flavorDimensions += "environment"

    productFlavors {
        create("dev") {
            dimension = "environment"
            applicationId = "com.fortymm.android.dev"
            buildConfigField(
                "String",
                "API_BASE_URL",
                buildConfigString(providers.gradleProperty("devApiBaseUrl").getOrElse("http://127.0.0.1:8080")),
            )
        }
        create("qa") {
            dimension = "environment"
            applicationId = "com.fortymm.android.qa"
            buildConfigField(
                "String",
                "API_BASE_URL",
                buildConfigString(providers.gradleProperty("qaApiBaseUrl").getOrElse("http://127.0.0.1:8080")),
            )
        }
        create("production") {
            dimension = "environment"
            applicationId = "com.fortymm.android"
            buildConfigField("String", "API_BASE_URL", "\"https://uat.fortymm.com\"")
        }
    }

    sourceSets {
        getByName("dev") {
            manifest.srcFile("src/nonrelease/AndroidManifest.xml")
            res.srcDirs("src/dev/res", "src/nonrelease/res")
        }
        getByName("qa") {
            manifest.srcFile("src/nonrelease/AndroidManifest.xml")
            res.srcDirs("src/qa/res", "src/nonrelease/res")
        }
    }

    defaultConfig {
        applicationId = "com.fortymm.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.register("verifyVariantArtifacts") {
    dependsOn("assembleDevRelease", "assembleQaRelease", "assembleProductionRelease")

    doLast {
        val sdkRoot = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
            ?: error("Set ANDROID_HOME or ANDROID_SDK_ROOT to inspect packaged Android manifests")
        val aapt = file("$sdkRoot/build-tools/35.0.0/aapt")
        check(aapt.canExecute()) { "Expected aapt at $aapt" }

        val variants = mapOf(
            "dev" to ("com.fortymm.android.dev" to "FortyMM Dev"),
            "qa" to ("com.fortymm.android.qa" to "FortyMM QA"),
            "production" to ("com.fortymm.android" to "FortyMM"),
        )
        val apks = variants.mapValues { (flavor, _) ->
            val apkDirectory = layout.buildDirectory.dir("outputs/apk/$flavor/release").get().asFile
            apkDirectory.listFiles()?.singleOrNull { it.extension == "apk" }
                ?: error("Expected one $flavor release APK in $apkDirectory")
        }

        apks.forEach { (flavor, apk) ->
            val (applicationId, label) = variants.getValue(flavor)
            val badgingText = providers.exec {
                commandLine(aapt, "dump", "badging", apk)
            }.standardOutput.asText.get()
            check("package: name='$applicationId'" in badgingText) {
                "$flavor APK has the wrong application ID"
            }
            check("application-label:'$label'" in badgingText) {
                "$flavor APK has the wrong launcher label"
            }
        }

        val productionApk = apks.getValue("production")
        ZipFile(productionApk).use { archive ->
            check(archive.getEntry("AndroidManifest.xml") != null) {
                "Production APK is missing its Android manifest"
            }
            check(archive.getEntry("res/xml/network_security_config.xml") == null) {
                "Production APK must not package a nonrelease cleartext policy"
            }
        }

        val manifestText = providers.exec {
            commandLine(aapt, "dump", "xmltree", productionApk, "AndroidManifest.xml")
        }.standardOutput.asText.get()
        val cleartextAttribute = manifestText.lineSequence()
            .singleOrNull { "usesCleartextTraffic" in it }
        check(cleartextAttribute?.contains("(type 0x12)0x0") == true) {
            "Production APK manifest must set usesCleartextTraffic=false"
        }
        check("networkSecurityConfig" !in manifestText) {
            "Production APK manifest must not reference a network security config"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
