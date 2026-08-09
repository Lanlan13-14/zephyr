package one.zephyr.mobile.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import one.zephyr.mobile.model.NetworkPolicy

/** What the device is currently attached to. */
data class NetworkState(
    val connected: Boolean,
    val unmetered: Boolean,
    val vpn: Boolean = false,
) {
    /**
     * A metered link blocks an automatic round when the user picked wifiOnly, but never blocks a
     * manual one: PRODUCT_REQUIREMENTS.md 12 makes a non-functional 立即同步 a release blocker.
     */
    fun allowsAutomatic(policy: NetworkPolicy): Boolean = when {
        !connected -> false
        policy == NetworkPolicy.WIFI_ONLY -> unmetered
        else -> true
    }

    companion object {
        val offline = NetworkState(connected = false, unmetered = false)
    }
}

/**
 * Connectivity as a flow.
 *
 * The transition from unavailable to available is a sync trigger (SyncTrigger.NETWORK_RESTORED), so
 * this has to be an observable stream rather than a point-in-time query.
 */
class NetworkMonitor(private val context: Context) {

    fun states(): Flow<NetworkState> = callbackFlow {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        if (manager == null) {
            trySend(NetworkState.offline)
            awaitClose { }
            return@callbackFlow
        }

        fun emitCurrent() {
            trySend(snapshot(manager))
        }

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = emitCurrent()
            override fun onLost(network: Network) = emitCurrent()
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = emitCurrent()
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        manager.registerNetworkCallback(request, callback)
        emitCurrent()

        awaitClose { manager.unregisterNetworkCallback(callback) }
    }.distinctUntilChanged()

    fun current(): NetworkState {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return NetworkState.offline
        return snapshot(manager)
    }

    private fun snapshot(manager: ConnectivityManager): NetworkState {
        val network = manager.activeNetwork ?: return NetworkState.offline
        val capabilities = manager.getNetworkCapabilities(network) ?: return NetworkState.offline
        return NetworkState(
            connected = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            // NOT_METERED rather than "is wifi": a metered hotspot must count as metered even
            // though the transport is wifi.
            unmetered = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            vpn = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
        )
    }
}
