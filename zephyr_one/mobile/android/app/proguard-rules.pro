# SSHJ discovers ciphers, key types and key-file factories by reflection.
# OpenSSH v1 lives in com.hierynomus.sshj, not net.schmizz.sshj; dropping it
# makes every modern private key fail after R8.
-dontwarn sun.security.x509.X509Key
-dontwarn sun.security.**
-dontwarn org.slf4j.**
-dontwarn org.bouncycastle.**
-dontwarn com.hierynomus.**
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
-keep class org.bouncycastle.** { *; }
