# protocol-ffmpeg ships no Java APIs that R8 must keep beyond JNI names.
-keep class one.zephyr.mobile.protocol.ffmpeg.FfmpegImage {
    native <methods>;
}
