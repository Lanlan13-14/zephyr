package one.zephyr.mobile.network

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import one.zephyr.mobile.model.TlsPolicy

/**
 * TLS trust configuration.
 *
 * There is deliberately no "ignore certificate errors" branch anywhere in this file. DEVELOPMENT.md
 * 840 makes TLS the floor, and a self-signed deployment is supported by pinning an explicit SPKI
 * hash instead of disabling validation. A trust-all manager would also silently defeat the device
 * envelope, because an attacker who can terminate TLS can serve their own bind response.
 */
object TlsConfigurator {

    fun apply(builder: OkHttpClient.Builder, policy: TlsPolicy, host: String): OkHttpClient.Builder =
        when (policy) {
            // System trust store, hostname verification on, no pinning: the correct default for a
            // publicly-issued certificate.
            TlsPolicy.SystemTrust -> builder

            is TlsPolicy.PinnedSpki -> {
                val pinner = CertificatePinner.Builder()
                    .apply {
                        for (pin in policy.sha256Pins) {
                            // OkHttp expects the "sha256/BASE64" form; accept either spelling from
                            // the pairing screen so a pasted fingerprint works.
                            add(host, if (pin.startsWith("sha256/")) pin else "sha256/" + pin)
                        }
                    }
                    .build()
                builder.certificatePinner(pinner)
            }
        }

    /**
     * Strict system trust manager, used to keep hostname and chain validation while pinning.
     *
     * Exposed so the pairing screen can show the certificate it is about to pin without having to
     * relax validation to fetch it.
     */
    fun systemTrustManager(): X509TrustManager {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as java.security.KeyStore?)
        return factory.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
            ?: throw IllegalStateException("no system X509 trust manager available")
    }

    fun sslContext(): SSLContext =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(systemTrustManager()), null) }

    /**
     * SHA-256 of the SubjectPublicKeyInfo, base64 encoded. This is what the user compares against
     * the value the Zephyr server prints, and it survives certificate renewal with the same key.
     */
    fun spkiPin(certificate: X509Certificate): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(certificate.publicKey.encoded)
        return "sha256/" + one.zephyr.mobile.model.Base64Codec.encode(digest)
    }

    fun assertPinMatches(policy: TlsPolicy, chain: List<X509Certificate>) {
        if (policy !is TlsPolicy.PinnedSpki) return
        val pins = policy.sha256Pins.map { if (it.startsWith("sha256/")) it else "sha256/" + it }.toSet()
        if (chain.none { pins.contains(spkiPin(it)) }) {
            throw CertificateException("no certificate in the chain matches the pinned SPKI set")
        }
    }
}
