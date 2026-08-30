package one.zephyr.mobile.network

import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import one.zephyr.mobile.model.TlsPolicy

/**
 * TLS trust configuration for OkHttp (bind / mobile-v1) and the PEM bundle the
 * embedded Go Link process loads via SSL_CERT_FILE.
 *
 * Default remains system CA trust. [TlsPolicy.InsecureTrust] is an explicit
 * bind-time switch for this host only; hostname still has to match.
 */
object TlsConfigurator {

    fun apply(builder: OkHttpClient.Builder, policy: TlsPolicy, host: String): OkHttpClient.Builder =
        when (policy) {
            TlsPolicy.SystemTrust -> builder
            TlsPolicy.InsecureTrust -> applyInsecure(builder, host)
            is TlsPolicy.PinnedSpki -> {
                val pinner = CertificatePinner.Builder()
                    .apply {
                        for (pin in policy.sha256Pins) {
                            add(host, if (pin.startsWith("sha256/")) pin else "sha256/" + pin)
                        }
                    }
                    .build()
                builder.certificatePinner(pinner)
            }
        }

    private fun applyInsecure(builder: OkHttpClient.Builder, host: String): OkHttpClient.Builder {
        val expected = host.lowercase()
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw CertificateException("empty certificate chain")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
        return builder
            .sslSocketFactory(ssl.socketFactory, trustAll)
            .hostnameVerifier { hostname, _ -> hostname.equals(expected, ignoreCase = true) }
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

    /** PEM bundle of the Android system + user CA store, for Go's SSL_CERT_FILE. */
    fun systemCaBundlePem(): ByteArray {
        val certs = linkedMapOf<String, X509Certificate>()
        runCatching {
            val store = java.security.KeyStore.getInstance("AndroidCAStore")
            store.load(null)
            val aliases = store.aliases()
            while (aliases.hasMoreElements()) {
                val cert = store.getCertificate(aliases.nextElement()) as? X509Certificate ?: continue
                certs[spkiPin(cert)] = cert
            }
        }
        if (certs.isEmpty()) {
            for (cert in systemTrustManager().acceptedIssuers) {
                certs[spkiPin(cert)] = cert
            }
        }
        check(certs.isNotEmpty()) { "Android system CA store is empty" }
        val encoder = Base64.getMimeEncoder(64, byteArrayOf('\n'.code.toByte()))
        val out = ByteArrayOutputStream()
        for (cert in certs.values) {
            out.write("-----BEGIN CERTIFICATE-----\n".toByteArray())
            out.write(encoder.encode(cert.encoded))
            out.write('\n'.code)
            out.write("-----END CERTIFICATE-----\n".toByteArray())
        }
        return out.toByteArray()
    }
}
