plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val designSystem = layout.projectDirectory.dir("../../references/design-system")

android {
    namespace = "com.fortymm.android"
    compileSdk = 37
    // The Docker image installs this version (BUILD_TOOLS_VERSION).
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "com.fortymm.android"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests {
            // Robolectric reads the app's merged resources, such as the font.
            isIncludeAndroidResources = true
        }
    }
}

// Copies the design system's own font into the app's resources, so the app
// can't drift from it. Resource names must be lowercase.
abstract class CopyDisplayFont : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val font: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(font)
            into(outputDir.dir("font"))
            rename { "bebas_neue_regular.ttf" }
        }
    }
}

val copyDisplayFont = tasks.register<CopyDisplayFont>("copyDisplayFont") {
    font = designSystem.file("fonts/BebasNeue-Regular.ttf")
}

androidComponents {
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(copyDisplayFont, CopyDisplayFont::outputDir)
    }
}

val colorsAndType = designSystem.file("colors_and_type.css")

tasks.withType<Test>().configureEach {
    inputs.file(colorsAndType).withPathSensitivity(PathSensitivity.NONE)
    systemProperty("fortymm.colorsAndType", colorsAndType.asFile.path)
    systemProperty("fortymm.screenshots", layout.buildDirectory.dir("screenshots").get().asFile.path)
    // Robolectric's Android 15+ sandboxes reach into the JDK's file descriptors.
    jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED")
    // Robolectric downloads its Android jars here, so they last as long as
    // Gradle's cache (a volume in Docker).
    systemProperty("maven.repo.local", gradle.gradleUserHomeDir.resolve("robolectric").path)
    // `mise run android-client:test` runs the unit tests and
    // `android-client:e2e` the UI tests, whose classes end in UiTest.
    when (providers.gradleProperty("tests").orNull) {
        "unit" -> filter.excludeTestsMatching("*UiTest")
        "ui" -> filter.includeTestsMatching("*UiTest")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")

    testImplementation(composeBom)
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
