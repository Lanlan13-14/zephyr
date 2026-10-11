# Consumer rules for this module.
# kotlinx.serialization keeps its own @Serializable metadata through the plugin's rules.

# libvlc-all 3.6.5 ships no proguard.txt. libvlcjni.so resolves Java members by
# name at runtime (GetMethodID/GetFieldID on dispatchEventFromNative, mInstance,
# onEventNative, the create*TrackFromNative factories, ...). R8 keeps the class
# names (they appear in the dex) but renames the members, and JNI_OnLoad then
# returns JNI_ERR: UnsatisfiedLinkError on every preview open. Keep the whole
# org.videolan tree, the way the official VLC app's own rules do.
-keep class org.videolan.libvlc.** { *; }
-keep interface org.videolan.libvlc.** { *; }
-dontwarn org.videolan.libvlc.**
