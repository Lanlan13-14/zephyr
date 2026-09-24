; Zephyr One NSIS customization.
;
; The app pins its Electron userData to %APPDATA%\com.zephyr.one (see
; app.setPath in electron/main.mjs), which electron-builder's built-in
; deleteAppDataOnUninstall does not know about — that option only removes
; $APPDATA\<productName>. A "delete and reinstall still has all my data"
; report came from exactly that gap.
;
; customUnInstall runs inside the uninstaller's uninstall section.

!macro customUnInstall
  ; Only meaningful for the interactive (non oneClick) uninstaller, which is
  ; what this package ships.
  ${ifNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "是否同时删除 Zephyr One 的全部本地数据（连接、密钥、设置）？$\r$\n$\r$\n选择 [否] 将保留数据，下次安装可继续使用。" \
      IDYES zephyr_delete_data IDNO zephyr_keep_data

    zephyr_delete_data:
      ; Electron userData (Roaming). zephyr-data, keys, settings live here.
      RMDir /r "$APPDATA\com.zephyr.one"
      ; Some Electron caches land under Local instead of Roaming.
      RMDir /r "$LOCALAPPDATA\com.zephyr.one"
      RMDir /r "$LOCALAPPDATA\zephyr-one"
      RMDir /r "$LOCALAPPDATA\Zephyr One"
      Goto zephyr_data_done

    zephyr_keep_data:

    zephyr_data_done:
  ${endIf}
!macroend