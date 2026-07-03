{
  "targets": [
    {
      "target_name": "rdp_addon",
      "sources": ["rdp_addon.c"],
      "include_dirs": ["<!@(pkg-config --cflags-only-I freerdp3 winpr3 2>/dev/null | sed 's/-I//g')"],
      "libraries": ["-lrdp_bridge", "-ldl"],
      "cflags": ["-std=c11", "-O2", "-Wall"],
      "defines": []
    }
  ]
}
