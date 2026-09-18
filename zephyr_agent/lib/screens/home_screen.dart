import 'dart:async';
import 'dart:io' as io;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../agent/agent_controller.dart';
import '../agent/agent_state.dart';
import '../agent/link_enrollment_client.dart';
import '../app/agent_version.dart';
import '../fs/file_provider.dart';
import '../i18n/agent_strings.dart';
import '../storage/local_settings.dart';
import '../theme/zephyr_colors.dart';
import '../ui/apple_spinner.dart';
import '../ui/glass_button.dart';
import '../ui/glass_sheet.dart';
import '../ui/settings_group.dart';

class HomeScreen extends StatefulWidget {
  final ZephyrTheme currentTheme;
  final ValueChanged<ZephyrTheme> onThemeChanged;

  const HomeScreen({
    super.key,
    required this.currentTheme,
    required this.onThemeChanged,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _BindSheetBody extends StatelessWidget {
  final EnrollmentInfo info;
  const _BindSheetBody({required this.info});

  String _expiresLabel(AgentStrings s) {
    final ms = info.expiresAt;
    if (ms <= 0) return '';
    final remaining = DateTime.fromMillisecondsSinceEpoch(ms).difference(DateTime.now());
    if (remaining.isNegative) return s.bindingExpiring;
    return s.bindingExpires(remaining.inMinutes);
  }

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    final s = AgentStrings.of(Localizations.localeOf(context));
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.bindingEnterCode,
            style: TextStyle(fontSize: 13, color: palette.textSecondary)),
        const SizedBox(height: 12),
        // Large monospaced user code — the single thing the human must read.
        Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            color: palette.surface,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            info.userCode,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, letterSpacing: 2, fontFamily: 'monospace'),
          ),
        ),
        const SizedBox(height: 12),
        Text(s.bindingCheckSas, style: TextStyle(fontSize: 12, color: palette.textSecondary)),
        const SizedBox(height: 4),
        Text(info.sas,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, fontFamily: 'monospace', color: palette.accent)),
        const SizedBox(height: 12),
        Text(s.bindingOpenLink, style: TextStyle(fontSize: 12, color: palette.textSecondary)),
        const SizedBox(height: 4),
        SelectableText(info.verificationUri,
            style: TextStyle(fontSize: 11, color: palette.textSecondary)),
        if (_expiresLabel(s).isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_expiresLabel(s), textAlign: TextAlign.center,
                style: TextStyle(fontSize: 11, color: palette.textSecondary)),
          ),
      ],
    );
  }
}

class _HomeScreenState extends State<HomeScreen> {
  late TextEditingController _urlCtrl;
  late TextEditingController _nameCtrl;
  Timer? _countdownTimer;

  AgentStrings get _s => AgentStrings.system;

  @override
  void initState() {
    super.initState();
    final config = context.read<AgentController>().config;
    _applyDefaultSharePath(config);
    _urlCtrl = TextEditingController(text: config.serverUrl);
    _nameCtrl = TextEditingController(text: config.deviceName);

    // Update countdown display
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _nameCtrl.dispose();
    _countdownTimer?.cancel();
    super.dispose();
  }

  ZephyrPalette get _palette => ZephyrColors.palette(widget.currentTheme, Theme.of(context).brightness);

  void _saveConfig(AgentController ctrl) {
    final url = AgentController.normalizeServerUrl(_urlCtrl.text);
    if (_urlCtrl.text.trim() != url) _urlCtrl.text = url;
    ctrl.config.serverUrl = url;
    ctrl.config.deviceName = _nameCtrl.text.trim();
    ctrl.updateConfig(ctrl.config);
    LocalSettings.saveConfig(ctrl.config);
  }

  void _saveAndNotify(AgentController ctrl) {
    _saveConfig(ctrl);
    _showSnack(_s.snackSaved);
  }

  Future<void> _resetSettings(AgentController ctrl) async {
    await ctrl.stop();
    await LocalSettings.resetAll();
    final fresh = AgentConfig();
    _applyDefaultSharePath(fresh);
    _urlCtrl.text = fresh.serverUrl;
    _nameCtrl.text = fresh.deviceName;
    ctrl.updateConfig(fresh);
    widget.onThemeChanged(ZephyrTheme.frost);
    await LocalSettings.saveConfig(fresh);
    _showSnack(_s.snackReset);
  }

  void _applyDefaultSharePath(AgentConfig config) {
    if (config.sharedDirectoryPath != null) return;
    if (io.Platform.isIOS) {
      final home = io.Platform.environment['HOME'] ?? '';
      final docs = home.isNotEmpty ? '$home/Documents' : io.Directory.systemTemp.path;
      try { io.Directory(docs).createSync(recursive: true); } catch (_) {}
      config.sharedDirectoryPath = docs;
      config.sharedDirectoryName = 'Documents';
      return;
    }
    if (io.Platform.isAndroid) {
      config.sharedDirectoryPath = '/storage/emulated/0';
      config.sharedDirectoryName = config.deviceName;
      return;
    }
    if (io.Platform.isWindows) {
      // Prefer the user profile, not C:\. Mapping the system drive root makes
      // Explorer enumerate protected system objects and historically failed
      // the entire list RPC on the first AccessDenied entry.
      final profile = io.Platform.environment['USERPROFILE']
          ?? io.Platform.environment['HOME'];
      if (profile != null && profile.isNotEmpty) {
        config.sharedDirectoryPath = profile;
        config.sharedDirectoryName =
            profile.split('\\').where((s) => s.isNotEmpty).last;
        return;
      }
      final drive = io.Platform.environment['SystemDrive'] ?? 'C:';
      config.sharedDirectoryPath = drive.endsWith('\\') ? drive : '$drive\\';
      config.sharedDirectoryName = drive.replaceAll(':', '');
      return;
    }
    if (io.Platform.isMacOS || io.Platform.isLinux) {
      final home = io.Platform.environment['HOME'];
      if (home != null && home.isNotEmpty) {
        config.sharedDirectoryPath = home;
        config.sharedDirectoryName =
            home.split('/').where((s) => s.isNotEmpty).last;
        return;
      }
    }
    config.sharedDirectoryPath = io.Directory.systemTemp.path;
    config.sharedDirectoryName = 'Temp';
  }

  Future<void> _pickDirectory(AgentController ctrl) async {
    final s = _s;
    if (io.Platform.isAndroid) {
      final choice = await showGlassSheet<String>(
        context: context,
        builder: (ctx) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(s.sheetShareLocation, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const SizedBox(height: 12),
              SettingsGroup(children: [
                SettingsRow(icon: Icons.storage, iconColor: _palette.accent, title: s.shareEntireStorage, showChevron: true, onTap: () => Navigator.pop(ctx, 'all')),
                SettingsRow(icon: Icons.folder_open, iconColor: _palette.accent, title: s.sharePickDirectory, showChevron: true, onTap: () => Navigator.pop(ctx, 'saf')),
                SettingsRow(icon: Icons.edit, iconColor: _palette.textSecondary, title: s.shareEnterPath, showChevron: true, onTap: () => Navigator.pop(ctx, 'path')),
              ]),
            ],
          ),
        ),
      );
      if (choice == null) return;
      if (choice == 'saf') {
        final selected = await AndroidSafFileProvider.selectDirectory();
        if (selected == null) return;
        setState(() {
          ctrl.config.sharedDirectoryPath = selected.rootUri;
          ctrl.config.sharedDirectoryName = selected.name;
        });
        _saveConfig(ctrl);
        return;
      }
      if (choice == 'path') {
        await _showDesktopPathDialog(ctrl);
        return;
      }
      final hasAllFiles = await AndroidStorageAccess.hasAllFilesAccess();
      if (!hasAllFiles) {
        await AndroidStorageAccess.openAllFilesAccessSettings();
        _showSnack(s.snackGrantAllFiles);
        return;
      }
      final root = await AndroidStorageAccess.externalStorageRoot();
      setState(() {
        ctrl.config.sharedDirectoryPath = root;
        ctrl.config.sharedDirectoryName = ctrl.config.deviceName;
      });
      _saveConfig(ctrl);
      return;
    }

    await _showDesktopPathDialog(ctrl);
  }

  Future<void> _showDesktopPathDialog(AgentController ctrl) async {
    final s = _s;
    final pathCtrl = TextEditingController(text: ctrl.config.sharedDirectoryPath ?? '');
    final result = await showGlassSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(left: 16, right: 16, top: 4, bottom: MediaQuery.viewInsetsOf(ctx).bottom + 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(s.sheetSharedDirectory, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            SettingsGroup(children: [
              SettingsFieldRow(label: s.fieldPath, controller: pathCtrl, enabled: true, placeholder: '/Users/name/Downloads'),
            ]),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: TextButton(onPressed: () => Navigator.pop(ctx), child: Text(s.actionCancel))),
              Expanded(child: TextButton(onPressed: () => Navigator.pop(ctx, pathCtrl.text.trim()), child: Text(s.actionDone))),
            ]),
          ],
        ),
      ),
    );
    if (result == null || result.isEmpty) return;
    setState(() {
      ctrl.config.sharedDirectoryPath = result;
      ctrl.config.sharedDirectoryName = result.split('/').last.split('\\').last;
    });
    _saveConfig(ctrl);
  }

  Future<void> _startConnection(AgentController ctrl) async {
    final s = _s;
    _saveConfig(ctrl);

    if (ctrl.config.serverUrl.isEmpty) {
      _showSnack(s.snackNeedServer);
      return;
    }
    final bound = ctrl.config.accessCredential != null && ctrl.config.accessCredential!.isNotEmpty;
    if (!bound && ctrl.config.token.isEmpty) {
      _showSnack(s.snackNeedBinding);
      return;
    }
    if (ctrl.config.sharedDirectoryPath == null) {
      _showSnack(s.snackNeedDirectory);
      return;
    }

    if (io.Platform.isAndroid) {
      final path = ctrl.config.sharedDirectoryPath!;
      if (path.startsWith('content://')) {
        ctrl.setFileProvider(AndroidSafFileProvider(path));
      } else {
        final hasAllFiles = await AndroidStorageAccess.hasAllFilesAccess();
        if (!hasAllFiles) {
          await AndroidStorageAccess.openAllFilesAccessSettings();
          _showSnack(s.snackNeedAllFiles);
          return;
        }
        ctrl.setFileProvider(DesktopFileProvider(path));
      }
    } else {
      ctrl.setFileProvider(DesktopFileProvider(ctrl.config.sharedDirectoryPath!));
    }
    await ctrl.start();
  }

  void _showSnack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    return Consumer<AgentController>(
      builder: (context, ctrl, _) {
        final isActive = ctrl.status.isActive;
        final accent = _palette.accent;
        return SettingsPalette(
          palette: _palette,
          child: Scaffold(
            appBar: AppBar(
              leadingWidth: 96,
              leading: Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton(tooltip: s.tooltipReset, icon: const Icon(Icons.restart_alt), onPressed: () => _resetSettings(ctrl)),
                IconButton(tooltip: s.tooltipSave, icon: const Icon(Icons.save_outlined), onPressed: () => _saveAndNotify(ctrl)),
              ]),
              title: Row(mainAxisSize: MainAxisSize.min, children: [
                ZephyrMark(palette: _palette, size: 26),
                const SizedBox(width: 8),
                Text(s.appTitle),
              ]),
            ),
            bottomNavigationBar: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 10, top: 4),
                child: Text(AgentVersion.tag, textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11, letterSpacing: 0.2, color: _palette.textSecondary.withValues(alpha: 0.72))),
              ),
            ),
            body: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                _statusGroup(ctrl, s),
                _connectionGroup(ctrl, isActive, s),
                _shareGroup(ctrl, isActive, accent, s),
                _accessGroup(ctrl, isActive, accent, s),
                _appearanceGroup(accent, s),
                if (isActive && (ctrl.linkError.isNotEmpty || !ctrl.linkTunnelUp)) _linkGroup(ctrl, s),
                if (ctrl.transferCount > 0) _statsGroup(ctrl, s),
                const SizedBox(height: 8),
                if (!isActive)
                  GlassPrimaryButton(label: s.actionStart, icon: Icons.play_arrow_rounded, color: accent, onPressed: () => _startConnection(ctrl))
                else ...[
                  GlassPrimaryButton(label: s.actionStop, icon: Icons.stop_rounded, color: _palette.danger, onPressed: () => ctrl.stop()),
                  if (ctrl.config.autoShutdown && ctrl.shutdownAt != null) ...[
                    const SizedBox(height: 10),
                    Center(child: TextButton(onPressed: () => ctrl.extendShutdown(), child: Text(s.extendMinutes(ctrl.config.autoShutdownMinutes)))),
                  ],
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _statusGroup(AgentController ctrl, AgentStrings s) {
    final status = ctrl.status;
    final Color dot = switch (status) {
      AgentStatus.online => _palette.success,
      AgentStatus.connecting || AgentStatus.authenticating || AgentStatus.reconnecting => _palette.warning,
      AgentStatus.error => _palette.danger,
      _ => _palette.textSecondary,
    };
    return SettingsGroup(header: s.groupStatus, children: [
      SettingsRow(icon: Icons.circle, iconColor: dot, title: s.statusLabel(status.name), detail: ctrl.errorMessage.isNotEmpty ? ctrl.errorMessage : ctrl.agentId),
      if (ctrl.config.autoShutdown && ctrl.shutdownAt != null)
        SettingsRow(icon: Icons.timer_outlined, iconColor: _palette.warning, title: s.rowAutoShutdown, trailing: _countdown(ctrl, s)),
    ]);
  }

  Widget _countdown(AgentController ctrl, AgentStrings s) {
    final remaining = ctrl.shutdownAt!.difference(DateTime.now());
    if (remaining.isNegative) return Text(s.closingSoon, style: TextStyle(color: _palette.danger, fontSize: 15));
    final m = remaining.inMinutes;
    final sec = remaining.inSeconds % 60;
    return Text('${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}',
        style: TextStyle(fontSize: 17, fontFamily: 'monospace', color: _palette.textSecondary));
  }

  Widget _connectionGroup(AgentController ctrl, bool isActive, AgentStrings s) {
    return SettingsGroup(header: s.groupServer, children: [
      SettingsFieldRow(label: s.rowServerAddress, controller: _urlCtrl, enabled: !isActive, keyboardType: TextInputType.url, placeholder: 'https://zephyr.example.com'),
      SettingsRow(
        icon: Icons.verified_user_outlined,
        iconColor: ctrl.enrollmentStatus == s.enrollmentBound ? _palette.success : _palette.accent,
        title: s.rowDeviceBinding, detail: ctrl.enrollmentStatus, showChevron: true,
        onTap: isActive ? null : () => _openBinding(ctrl),
      ),
      SettingsToggleRow(
        icon: Icons.lock_open_outlined, iconColor: _palette.warning, title: s.rowAllowSelfSigned,
        value: ctrl.config.allowBadCertificates,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.allowBadCertificates = v); _saveConfig(ctrl); },
      ),
    ]);
  }

  Future<void> _openBinding(AgentController ctrl) async {
    final s = _s;
    if (ctrl.enrollmentStatus == s.enrollmentBound) {
      final unbind = await showGlassSheet<bool>(
        context: context,
        builder: (ctx) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(s.sheetBoundTitle, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Text(s.boundUsesIdentity, style: TextStyle(color: _palette.textSecondary, fontSize: 15)),
            const SizedBox(height: 16),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(s.actionUnbind, style: TextStyle(color: _palette.danger, fontSize: 17))),
          ]),
        ),
      );
      if (unbind == true) await ctrl.unbind();
      return;
    }
    await _startEnrollment(ctrl);
  }

  Widget _shareGroup(AgentController ctrl, bool isActive, Color accent, AgentStrings s) {
    return SettingsGroup(header: s.groupSharing, children: [
      SettingsRow(
        icon: Icons.folder_outlined, iconColor: accent, title: s.rowSharedDirectory,
        detail: (ctrl.config.sharedDirectoryPath ?? '').isEmpty ? s.noDirectorySelected : ctrl.config.sharedDirectoryPath,
        showChevron: !isActive, onTap: isActive ? null : () => _pickDirectory(ctrl),
      ),
      SettingsToggleRow(
        icon: Icons.lock_outline, iconColor: accent, title: s.rowReadOnly,
        value: ctrl.config.readOnly,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.readOnly = v); _saveConfig(ctrl); },
      ),
    ]);
  }

  Widget _accessGroup(AgentController ctrl, bool isActive, Color accent, AgentStrings s) {
    return SettingsGroup(header: s.groupAccess, children: [
      SettingsToggleRow(
        icon: Icons.alt_route, iconColor: accent, title: s.rowBastion,
        value: ctrl.config.bastionEnabled,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.bastionEnabled = v); _saveConfig(ctrl); },
      ),
      SettingsToggleRow(
        icon: Icons.timer_outlined, iconColor: _palette.warning, title: s.rowAutoShutdownAccess,
        value: ctrl.config.autoShutdown,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.autoShutdown = v); _saveConfig(ctrl); },
      ),
    ]);
  }

  Widget _appearanceGroup(Color accent, AgentStrings s) {
    final brightness = Theme.of(context).brightness;
    return SettingsGroup(header: s.groupAppearance, children: [
      SettingsRow(
        icon: Icons.palette_outlined, iconColor: accent,
        title: s.rowTheme, detail: ZephyrThemeLabels.of(widget.currentTheme, s),
        showChevron: true,
        onTap: () async {
          final picked = await showGlassSheet<ZephyrTheme>(
            context: context,
            builder: (ctx) => Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(s.groupAppearance, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 12),
                  SettingsGroup(children: [
                    for (final t in ZephyrTheme.values)
                      SettingsRow(
                        icon: Icons.circle,
                        iconColor: ZephyrColors.palette(t, brightness).accent,
                        title: ZephyrThemeLabels.of(t, s),
                        trailing: t == widget.currentTheme ? Icon(Icons.check, size: 20, color: accent) : null,
                        onTap: () => Navigator.pop(ctx, t),
                      ),
                  ]),
                ],
              ),
            ),
          );
          if (picked != null) widget.onThemeChanged(picked);
        },
      ),
    ]);
  }

  Widget _linkGroup(AgentController ctrl, AgentStrings s) {
    final error = ctrl.linkError;
    return SettingsGroup(header: s.groupLink, footer: error.isEmpty ? null : error, children: [
      SettingsRow(
        icon: error.isEmpty ? Icons.check_circle_outline : Icons.error_outline,
        iconColor: error.isEmpty ? _palette.success : _palette.danger,
        title: error.isEmpty ? s.linkEstablished : s.linkNotEstablished,
      ),
    ]);
  }

  Widget _statsGroup(AgentController ctrl, AgentStrings s) {
    final bytes = ctrl.transferBytes;
    final bytesStr = bytes < 1024 ? '$bytes B' : bytes < 1024 * 1024
        ? '${(bytes / 1024).toStringAsFixed(1)} KB' : '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    return SettingsGroup(header: s.groupTransfer, children: [
      SettingsRow(icon: Icons.swap_vert, iconColor: _palette.accent, title: s.transferRequests(ctrl.transferCount), detail: bytesStr),
    ]);
  }

  Future<void> _startEnrollment(AgentController ctrl) async {
    final s = _s;
    _saveConfig(ctrl);
    ctrl.enroll();
    if (!mounted) return;
    await showGlassSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => ListenableBuilder(
        listenable: ctrl,
        builder: (sheetContext, _) {
          final info = ctrl.enrollment;
          final busy = ctrl.enrollmentBusy;
          final error = ctrl.enrollmentError;
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(info != null ? s.sheetWaitingApproval : (busy ? s.sheetCreatingBinding : s.sheetBindingResult),
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
              const SizedBox(height: 16),
              if (info != null) _BindSheetBody(info: info)
              else if (error != null) Text(error, style: TextStyle(fontSize: 15, color: _palette.danger))
              else if (busy) const Padding(padding: EdgeInsets.all(24), child: AppleSpinner(radius: 12))
              else Text(s.bindingDone, style: const TextStyle(fontSize: 17)),
              const SizedBox(height: 20),
              TextButton(onPressed: () => Navigator.pop(sheetContext), child: Text(info != null ? s.actionWaitBackground : s.actionDone)),
            ]),
          );
        },
      ),
    );
    if (ctrl.config.accessCredential != null && ctrl.enrollmentError == null) {
      _showSnack(s.snackBound);
    }
  }
}

class ZephyrMark extends StatelessWidget {
  final ZephyrPalette palette;
  final double size;

  const ZephyrMark({super.key, required this.palette, this.size = 24});

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.square(size),
      painter: _ZephyrMarkPainter(palette),
    );
  }
}

class _ZephyrMarkPainter extends CustomPainter {
  final ZephyrPalette palette;
  _ZephyrMarkPainter(this.palette);

  @override
  void paint(Canvas canvas, Size size) {
    final scaleX = size.width / 200;
    final scaleY = size.height / 200;
    Offset p(double x, double y) => Offset(x * scaleX, y * scaleY);
    final rect = Offset.zero & size;
    final gradient = LinearGradient(
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
      colors: [palette.iconStart, palette.iconMid, palette.iconEnd],
      stops: [0, palette.iconMidStop, 1],
    ).createShader(rect);

    final main = Path()
      ..moveTo(p(43, 64).dx, p(43, 64).dy)
      ..cubicTo(p(84, 44).dx, p(84, 44).dy, p(138, 52).dx, p(138, 52).dy, p(160, 77).dx, p(160, 77).dy)
      ..cubicTo(p(148, 94).dx, p(148, 94).dy, p(108, 104).dx, p(108, 104).dy, p(76, 123).dx, p(76, 123).dy);
    final mid = Path()
      ..moveTo(p(49, 76).dx, p(49, 76).dy)
      ..cubicTo(p(89, 74).dx, p(89, 74).dy, p(126, 89).dx, p(126, 89).dy, p(145, 115).dx, p(145, 115).dy)
      ..cubicTo(p(120, 134).dx, p(120, 134).dy, p(76, 153).dx, p(76, 153).dy, p(40, 135).dx, p(40, 135).dy);
    final tail = Path()
      ..moveTo(p(80, 92).dx, p(80, 92).dy)
      ..cubicTo(p(108, 108).dx, p(108, 108).dy, p(137, 135).dx, p(137, 135).dy, p(162, 129).dx, p(162, 129).dy);

    void stroke(Path path, double width, double opacity) {
      canvas.drawPath(
        path,
        Paint()
          ..shader = gradient
          ..style = PaintingStyle.stroke
          ..strokeWidth = width * size.width / 200
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round
          ..color = palette.accent.withValues(alpha: opacity),
      );
    }

    stroke(main, 10, 1);
    stroke(mid, 6, .86);
    stroke(tail, 3.5, .62);
    canvas.drawCircle(p(145, 115), 4.5 * size.width / 200, Paint()..color = palette.iconDotA.withValues(alpha: .9));
  }

  @override
  bool shouldRepaint(covariant _ZephyrMarkPainter oldDelegate) => oldDelegate.palette != palette;
}
