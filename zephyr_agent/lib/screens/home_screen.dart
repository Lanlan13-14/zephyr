import 'dart:async';
import 'dart:io' as io;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../agent/agent_controller.dart';
import '../agent/agent_state.dart';
import '../agent/link_enrollment_client.dart';
import '../app/agent_version.dart';
import '../fs/file_provider.dart';
import '../storage/local_settings.dart';
import '../theme/zephyr_colors.dart';
import '../ui/glass_button.dart';
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

  String get _expiresLabel {
    final ms = info.expiresAt;
    if (ms <= 0) return '';
    final remaining = DateTime.fromMillisecondsSinceEpoch(ms).difference(DateTime.now());
    if (remaining.isNegative) return '即将过期';
    return '${remaining.inMinutes} 分钟内有效';
  }

  @override
  Widget build(BuildContext context) {
    final palette = SettingsPalette.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('在主端「设备绑定」页面输入以下验证码批准：',
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
        Text('确认安全码一致（防中间人）：', style: TextStyle(fontSize: 12, color: palette.textSecondary)),
        const SizedBox(height: 4),
        Text(info.sas,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, fontFamily: 'monospace', color: palette.accent)),
        const SizedBox(height: 12),
        Text('或打开链接批准：', style: TextStyle(fontSize: 12, color: palette.textSecondary)),
        const SizedBox(height: 4),
        SelectableText(info.verificationUri,
            style: TextStyle(fontSize: 11, color: palette.textSecondary)),
        if (_expiresLabel.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_expiresLabel, textAlign: TextAlign.center,
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
    _showSnack('连接信息已保存');
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
    _showSnack('设置已重置');
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
    if (io.Platform.isAndroid) {
      final choice = await showModalBottomSheet<String>(
        context: context,
        showDragHandle: true,
        builder: (ctx) => SettingsPalette(
          palette: _palette,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('共享位置', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 12),
                  SettingsGroup(children: [
                    SettingsRow(icon: Icons.storage, iconColor: _palette.accent, title: '整个共享存储', showChevron: true, onTap: () => Navigator.pop(ctx, 'all')),
                    SettingsRow(icon: Icons.folder_open, iconColor: _palette.accent, title: '选择目录', showChevron: true, onTap: () => Navigator.pop(ctx, 'saf')),
                    SettingsRow(icon: Icons.edit, iconColor: _palette.textSecondary, title: '输入路径', showChevron: true, onTap: () => Navigator.pop(ctx, 'path')),
                  ]),
                ],
              ),
            ),
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
        _showSnack('请在系统设置中授予“所有文件访问权限”，返回后再启动连接');
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
    final pathCtrl = TextEditingController(text: ctrl.config.sharedDirectoryPath ?? '');
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => SettingsPalette(
        palette: _palette,
        child: Padding(
          padding: EdgeInsets.only(left: 16, right: 16, top: 4, bottom: MediaQuery.viewInsetsOf(ctx).bottom + 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('共享目录', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              const SizedBox(height: 12),
              SettingsGroup(children: [
                SettingsFieldRow(label: '路径', controller: pathCtrl, enabled: true, placeholder: '/Users/name/Downloads'),
              ]),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(child: TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消'))),
                Expanded(child: TextButton(onPressed: () => Navigator.pop(ctx, pathCtrl.text.trim()), child: const Text('完成'))),
              ]),
            ],
          ),
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
    _saveConfig(ctrl);

    if (ctrl.config.serverUrl.isEmpty) {
      _showSnack('请填写主端地址');
      return;
    }
    final bound = ctrl.config.accessCredential != null && ctrl.config.accessCredential!.isNotEmpty;
    if (!bound && ctrl.config.token.isEmpty) {
      _showSnack('请先绑定设备，或填写旧版 Token 迁移');
      return;
    }
    if (ctrl.config.sharedDirectoryPath == null) {
      _showSnack('请选择共享目录');
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
          _showSnack('需要“所有文件访问权限”才能映射整个共享存储');
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
    return Consumer<AgentController>(
      builder: (context, ctrl, _) {
        final isActive = ctrl.status.isActive;
        final brightness = Theme.of(context).brightness;
        final accent = ZephyrColors.getPrimary(widget.currentTheme, brightness);
        return SettingsPalette(
          palette: _palette,
          child: Scaffold(
            appBar: AppBar(
              leadingWidth: 96,
              leading: Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton(tooltip: '重置设置', icon: const Icon(Icons.restart_alt), onPressed: () => _resetSettings(ctrl)),
                IconButton(tooltip: '保存设置', icon: const Icon(Icons.save_outlined), onPressed: () => _saveAndNotify(ctrl)),
              ]),
              title: Row(mainAxisSize: MainAxisSize.min, children: [
                ZephyrMark(palette: _palette, size: 26),
                const SizedBox(width: 8),
                const Text('Zephyr Agent'),
              ]),
              actions: [
                PopupMenuButton<ZephyrTheme>(
                  icon: Icon(Icons.palette_outlined, color: accent),
                  onSelected: widget.onThemeChanged,
                  itemBuilder: (_) => ZephyrTheme.values.map((t) => PopupMenuItem(
                    value: t,
                    child: Row(children: [
                      ZephyrMark(palette: ZephyrColors.palette(t, brightness), size: 22),
                      const SizedBox(width: 8),
                      Text(t.label),
                      if (t == widget.currentTheme) ...[const Spacer(), Icon(Icons.check, size: 18, color: accent)],
                    ]),
                  )).toList(),
                ),
              ],
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
                _statusGroup(ctrl),
                _connectionGroup(ctrl, isActive, accent),
                _shareGroup(ctrl, isActive, accent),
                _accessGroup(ctrl, isActive, accent),
                if (isActive && (ctrl.linkError.isNotEmpty || !ctrl.linkTunnelUp)) _linkGroup(ctrl),
                if (ctrl.transferCount > 0) _statsGroup(ctrl),
                const SizedBox(height: 8),
                if (!isActive)
                  GlassPrimaryButton(label: '启动连接', icon: Icons.play_arrow_rounded, color: accent, onPressed: () => _startConnection(ctrl))
                else ...[
                  GlassPrimaryButton(label: '停止共享', icon: Icons.stop_rounded, color: _palette.danger, onPressed: () => ctrl.stop()),
                  if (ctrl.config.autoShutdown && ctrl.shutdownAt != null) ...[
                    const SizedBox(height: 10),
                    Center(child: TextButton(onPressed: () => ctrl.extendShutdown(), child: Text('延长 ${ctrl.config.autoShutdownMinutes} 分钟'))),
                  ],
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _statusGroup(AgentController ctrl) {
    final status = ctrl.status;
    final Color dot = switch (status) {
      AgentStatus.online => _palette.success,
      AgentStatus.connecting || AgentStatus.authenticating || AgentStatus.reconnecting => _palette.warning,
      AgentStatus.error => _palette.danger,
      _ => _palette.textSecondary,
    };
    return SettingsGroup(header: '状态', children: [
      SettingsRow(icon: Icons.circle, iconColor: dot, title: status.label, detail: ctrl.errorMessage.isNotEmpty ? ctrl.errorMessage : ctrl.agentId),
      if (ctrl.config.autoShutdown && ctrl.shutdownAt != null)
        SettingsRow(icon: Icons.timer_outlined, iconColor: _palette.warning, title: '自动关闭', trailing: _countdown(ctrl)),
    ]);
  }

  Widget _countdown(AgentController ctrl) {
    final remaining = ctrl.shutdownAt!.difference(DateTime.now());
    if (remaining.isNegative) return Text('即将关闭', style: TextStyle(color: _palette.danger, fontSize: 15));
    final m = remaining.inMinutes;
    final sec = remaining.inSeconds % 60;
    return Text('${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}',
        style: TextStyle(fontSize: 17, fontFamily: 'monospace', color: _palette.textSecondary));
  }

  Widget _connectionGroup(AgentController ctrl, bool isActive, Color accent) {
    return SettingsGroup(header: '主端', children: [
      SettingsFieldRow(label: '地址', controller: _urlCtrl, enabled: !isActive, keyboardType: TextInputType.url, placeholder: 'https://zephyr.example.com'),
      SettingsRow(
        icon: Icons.verified_user_outlined,
        iconColor: ctrl.enrollmentStatus == '已绑定' ? _palette.success : accent,
        title: '设备绑定', detail: ctrl.enrollmentStatus, showChevron: true,
        onTap: isActive ? null : () => _openBinding(ctrl),
      ),
      SettingsToggleRow(
        icon: Icons.lock_open_outlined, iconColor: _palette.warning, title: '允许自签名证书',
        value: ctrl.config.allowBadCertificates,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.allowBadCertificates = v); _saveConfig(ctrl); },
      ),
    ]);
  }

  Future<void> _openBinding(AgentController ctrl) async {
    if (ctrl.enrollmentStatus == '已绑定') {
      final unbind = await showModalBottomSheet<bool>(
        context: context, showDragHandle: true,
        builder: (ctx) => SettingsPalette(palette: _palette, child: SafeArea(child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('已绑定', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Text('使用设备身份，无需 Token', style: TextStyle(color: _palette.textSecondary, fontSize: 15)),
            const SizedBox(height: 16),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text('解绑', style: TextStyle(color: _palette.danger, fontSize: 17))),
          ]),
        ))),
      );
      if (unbind == true) await ctrl.unbind();
      return;
    }
    await _startEnrollment(ctrl);
  }

  Widget _shareGroup(AgentController ctrl, bool isActive, Color accent) {
    return SettingsGroup(header: '共享', children: [
      SettingsRow(
        icon: Icons.folder_outlined, iconColor: accent, title: '共享目录',
        detail: (ctrl.config.sharedDirectoryPath ?? '').isEmpty ? '未选择' : ctrl.config.sharedDirectoryPath,
        showChevron: !isActive, onTap: isActive ? null : () => _pickDirectory(ctrl),
      ),
      SettingsToggleRow(
        icon: Icons.lock_outline, iconColor: accent, title: '只读',
        value: ctrl.config.readOnly,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.readOnly = v); _saveConfig(ctrl); },
      ),
    ]);
  }

  Widget _accessGroup(AgentController ctrl, bool isActive, Color accent) {
    return SettingsGroup(header: '访问', children: [
      SettingsToggleRow(
        icon: Icons.alt_route, iconColor: accent, title: '作为跳板机',
        value: ctrl.config.bastionEnabled,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.bastionEnabled = v); _saveConfig(ctrl); },
      ),
      SettingsToggleRow(
        icon: Icons.timer_outlined, iconColor: _palette.warning, title: '闲置自动关闭',
        value: ctrl.config.autoShutdown,
        onChanged: isActive ? null : (v) { setState(() => ctrl.config.autoShutdown = v); _saveConfig(ctrl); },
      ),
    ]);
  }

  Widget _linkGroup(AgentController ctrl) {
    final error = ctrl.linkError;
    return SettingsGroup(header: '加密通道', footer: error.isEmpty ? null : error, children: [
      SettingsRow(
        icon: error.isEmpty ? Icons.check_circle_outline : Icons.error_outline,
        iconColor: error.isEmpty ? _palette.success : _palette.danger,
        title: error.isEmpty ? '已建立' : '未建立',
      ),
    ]);
  }

  Widget _statsGroup(AgentController ctrl) {
    final bytes = ctrl.transferBytes;
    final bytesStr = bytes < 1024 ? '$bytes B' : bytes < 1024 * 1024
        ? '${(bytes / 1024).toStringAsFixed(1)} KB' : '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    return SettingsGroup(header: '传输', children: [
      SettingsRow(icon: Icons.swap_vert, iconColor: _palette.accent, title: '${ctrl.transferCount} 次请求', detail: bytesStr),
    ]);
  }

  Future<void> _startEnrollment(AgentController ctrl) async {
    _saveConfig(ctrl);
    ctrl.enroll();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context, isScrollControlled: true, showDragHandle: true,
      builder: (sheetContext) => SettingsPalette(
        palette: _palette,
        child: ListenableBuilder(
          listenable: ctrl,
          builder: (sheetContext, _) {
            final info = ctrl.enrollment;
            final busy = ctrl.enrollmentBusy;
            final error = ctrl.enrollmentError;
            return SafeArea(child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(info != null ? '等待批准' : (busy ? '创建绑定…' : '绑定结果'),
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
                const SizedBox(height: 16),
                if (info != null) _BindSheetBody(info: info)
                else if (error != null) Text(error, style: TextStyle(fontSize: 15, color: _palette.danger))
                else if (busy) const Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())
                else const Text('绑定完成', style: TextStyle(fontSize: 17)),
                const SizedBox(height: 20),
                TextButton(onPressed: () => Navigator.pop(sheetContext), child: Text(info != null ? '后台等待' : '完成')),
              ]),
            ));
          },
        ),
      ),
    );
    if (ctrl.config.accessCredential != null && ctrl.enrollmentError == null) {
      _showSnack('设备绑定成功');
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
