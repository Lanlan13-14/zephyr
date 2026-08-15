# SSHJ / EdDSA reference desktop-only JDK classes. They are never used on Android.
-dontwarn sun.security.x509.X509Key
-dontwarn sun.security.**
-dontwarn org.slf4j.**
-dontwarn org.bouncycastle.**
-keep class net.schmizz.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
