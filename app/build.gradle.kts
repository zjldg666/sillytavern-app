import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 私密签名配置只保存在被 Git 排除的本机目录中。
val releaseSigningFile = rootProject.file(".tools/signing/release.properties")
val releaseSigning = Properties().apply {
    if (releaseSigningFile.exists()) releaseSigningFile.inputStream().use { load(it) }
}
val localTools = Properties().apply {
    val config = rootProject.file("local.properties")
    if (config.exists()) config.inputStream().use { load(it) }
}

android {
    namespace = "io.jiuguan.mobile"
    compileSdk = 35
    defaultConfig {
        applicationId = "io.jiuguan.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 137
        versionName = "1.2.17"
        ndk { abiFilters += "arm64-v8a" }
    }
    signingConfigs.getByName("debug") {
        storeFile = rootProject.file(".tools/android-debug.keystore")
    }
    if (releaseSigningFile.exists()) {
        signingConfigs.create("release") {
            storeFile = rootProject.file(releaseSigning.getProperty("storeFile"))
            storePassword = releaseSigning.getProperty("storePassword")
            keyAlias = releaseSigning.getProperty("keyAlias")
            keyPassword = releaseSigning.getProperty("keyPassword")
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "酒馆（开发版）")
        }
        release {
            isMinifyEnabled = false
            if (releaseSigningFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    sourceSets["main"].apply {
        assets.srcDir(layout.buildDirectory.dir("generated/upstream/assets"))
        jniLibs.srcDir(layout.buildDirectory.dir("generated/upstream/jniLibs"))
    }
    packaging.jniLibs {
        useLegacyPackaging = true
        // Node 是可执行文件，不能作为普通 JNI 库被 strip。
        keepDebugSymbols += "**/libjiuguan_node.so"
        keepDebugSymbols += "**/libc++_shared.so"
    }
    androidResources { noCompress += "zip" }
}

val prepareUpstream by tasks.registering(Exec::class) {
    workingDir(rootDir)
    commandLine(providers.gradleProperty("nodeExecutable").orNull ?: System.getenv("JIUGUAN_NODE") ?: localTools.getProperty("node.executable") ?: "node",
        "scripts/upstream/prepare-android.mjs")
}
tasks.named("preBuild").configure { dependsOn(prepareUpstream) }

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        check(releaseSigningFile.exists()) {
            "缺少 .tools/signing/release.properties，请恢复此项目原正式签名，勿重新生成更新密钥。"
        }
    }
}

// 使用项目内的开发密钥，避免依赖或改动用户全局的 Android 签名配置。
val prepareDebugKey by tasks.registering(Exec::class) {
    val key = rootProject.file(".tools/android-debug.keystore")
    onlyIf { !key.exists() }
    doFirst { key.parentFile.mkdirs() }
    commandLine(File(System.getProperty("java.home"), "bin/keytool").absolutePath,
        "-genkeypair", "-keystore", key.absolutePath, "-storepass", "android",
        "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
        "-validity", "10000", "-dname", "CN=Android Debug,O=Jiuguan,C=CN")
}
tasks.matching { it.name == "validateSigningDebug" }.configureEach { dependsOn(prepareDebugKey) }
