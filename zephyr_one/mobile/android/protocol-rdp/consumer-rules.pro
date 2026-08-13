# Consumer rules for this module.
# Kept intentionally empty: nothing here relies on reflection over its own types.
# kotlinx.serialization keeps its own @Serializable metadata through the plugin's rules.
-keep class one.zephyr.mobile.protocol.rdp.NativeRdpConfig { <fields>; }
-keep interface one.zephyr.mobile.protocol.rdp.NativeRdpSink { *; }
-keep class one.zephyr.mobile.protocol.rdp.JniRdpNativeBridge { *; }
