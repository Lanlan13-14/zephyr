# SSHJ discovers algorithms, key types and key-file factories by reflection.
# Do not keep org.bouncycastle.** wholesale: Android's cut-down provider has the same "BC" name,
# and retaining the external provider makes SSHJ fail X25519/ECDSA during connect(). Directly
# referenced parser primitives remain reachable without a provider-wide keep rule.
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.sshj.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
-dontwarn net.schmizz.sshj.**
-dontwarn org.bouncycastle.**
-dontwarn org.slf4j.**
-dontwarn sun.security.**
-dontwarn sun.security.x509.X509Key
-dontwarn com.hierynomus.**
