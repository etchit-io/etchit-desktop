import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) FileInputStream(f).use { load(it) }
}
val reownProjectId: String = localProps.getProperty("REOWN_PROJECT_ID", "")

android {
    namespace = "com.autonomi.antpaste"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.etchit"
        minSdk = 26
        targetSdk = 34
        versionCode = 7
        versionName = "0.2.1"

        buildConfigField("String", "REOWN_PROJECT_ID", "\"$reownProjectId\"")
        buildConfigField("long", "CHAIN_ID", "42161L")
        buildConfigField("String", "RPC_URL", "\"https://arb1.arbitrum.io/rpc\"")
        buildConfigField("String", "ANT_TOKEN_ADDRESS", "\"0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684\"")
        buildConfigField("String", "VAULT_ADDRESS", "\"0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26\"")
    }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file("release.keystore")
            storePassword = localProps.getProperty("KEYSTORE_PASSWORD", "")
            keyAlias = "etchit"
            keyPassword = localProps.getProperty("KEYSTORE_PASSWORD", "")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            ndk { abiFilters += listOf("arm64-v8a") }
        }
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/licenses/**",
                "META-INF/*.kotlin_module",
                "META-INF/versions/**",
                "META-INF/INDEX.LIST",
                "META-INF/DEPENDENCIES",
                "META-INF/NOTICE*",
                "META-INF/LICENSE*",
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.biometric:biometric:1.1.0")

    // Reown AppKit (WalletConnect v2). Firebase + Play Services are
    // excluded — Reown pulls them in for FCM-based push delivery, which
    // etchit doesn't use (we run a foreground service + heads-up
    // notifications instead). Excluding keeps the APK free of
    // proprietary Google libraries so it qualifies for IzzyOnDroid /
    // F-Droid distribution.
    implementation(platform("com.reown:android-bom:1.6.12"))
    implementation("com.reown:android-core") {
        exclude(group = "com.google.firebase")
        exclude(group = "com.google.android.gms")
    }
    implementation("com.reown:appkit") {
        exclude(group = "com.google.firebase")
        exclude(group = "com.google.android.gms")
    }

    // Jetpack Compose (hosts Reown AppKit modal)
    implementation(platform("androidx.compose:compose-bom:2024.05.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.9.6")
    implementation("com.google.accompanist:accompanist-navigation-material:0.36.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
}
