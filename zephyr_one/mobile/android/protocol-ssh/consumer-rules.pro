# SSHJ discovers algorithms and key types by reflection.
-keep class net.schmizz.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
-dontwarn net.schmizz.sshj.**
-dontwarn org.bouncycastle.**
-dontwarn org.slf4j.**
-dontwarn sun.security.**
-dontwarn sun.security.x509.X509Key
-dontwarn com.hierynomus.**
