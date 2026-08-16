# SSHJ discovers ciphers, key types and key-file factories by reflection.
# Keep SSHJ and the OpenSSH v1 parser, but do NOT keep BouncyCastleProvider on Android:
# Android already exposes a cut-down provider named BC. Shipping the external provider under the
# same name makes SSHJ select the cut-down instance and fail transport KEX before authentication.
-dontwarn sun.security.x509.X509Key
-dontwarn sun.security.**
-dontwarn org.slf4j.**
-dontwarn org.bouncycastle.**
-dontwarn com.hierynomus.**
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
