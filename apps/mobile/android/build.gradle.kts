allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Workaround for mapbox_maps_flutter 2.30.0 (latest stable) on AGP 9.
//
// Its android/build.gradle skips applying 'kotlin-android' when AGP >= 9, on the
// assumption that Kotlin is then built in — but it still uses the top-level
// `kotlin { }` extension, which only the Kotlin Gradle plugin registers. The result
// is "Could not find method kotlin()" and a failed build.
//
// Applying KGP to that subproject restores the extension it expects. Scoped to the
// one project so nothing else inherits it, and removable once upstream fixes the
// guard. See docs/technology-baseline.md.
subprojects {
    if (project.name == "mapbox_maps_flutter") {
        project.plugins.apply("org.jetbrains.kotlin.android")
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
