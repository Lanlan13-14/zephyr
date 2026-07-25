import 'dart:async';
import 'dart:io' as io;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../agent/agent_controller.dart';
import '../agent/agent_state.dart';
import '../app/agent_version.dart';
import '../fs/file_provider.dart';
import '../storage/local_settings.dart';
import '../theme/zephyr_colors.dart';

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

class _HomeScreenState extends State<HomeScreen> {
  late TextEditingController _urlCtrl;
  late TextEditingController _tokenCtrl;
  late TextEditingController _nameCtrl;
  Timer? _countdownTimer;

  @override
  void initState() {
    super.initState();
    final config = context.read<AgentController>().config;
    _applyDefaultSharePath(config);
    _urlCtrl = TextEditingController(text: config.serverUrl);
    _tokenCtrl = TextEditingController(text: config.token);
    _nameCtrl = TextEditingController(text: config.deviceName);

    // Update countdown display
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _tokenCtrl.dispose();
    _nameCtrl.dispose();
    _countdownTimer?.cancel();
    super.dispose();
  }

  ZephyrPalette get _palette => ZephyrColors.palette(widget.currentTheme, Theme.of(context).brightness);

  void _saveConfig(AgentController ctrl) {
    final url = AgentController.normalizeServerUrl(_urlCtrl.text);
    if (_urlCtrl.text.trim() != url) _urlCtrl.text = url;
    ctrl.config.serverUrl = url;
    ctrl.config.token = _tokenCtrl.text.trim();
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
    _tokenCtrl.text = fresh.token;
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
      final choice = await showDialog<String>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('选择映射位置'),
          children: [
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'all'),
              child: const ListTile(
                leading: Icon(Icons.storage),
                title: Text('映射整个共享存储'),
                subtitle: Text('/storage/emulated/0，需要“所有文件访问权限”'),
              ),
            ),
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'saf'),
              child: const ListTile(
                leading: Icon(Icons.folder_open),
                title: Text('选择自定义目录'),
                subtitle: Text('使用 Android SAF 授权一个目录'),
              ),
            ),
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, 'path'),
              child: const ListTile(
                leading: Icon(Icons.edit),
                title: Text('手动输入路径'),
                subtitle: Text('适合 root/Shizuku/特殊挂载路径'),
              ),
            ),
          ],
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
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('共享目录路径'),
        content: TextField(
          controller: pathCtrl,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: '/Users/name/Downloads 或 C:\\Users\\name\\Downloads',
            labelText: '本机目录路径',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          ElevatedButton(onPressed: () => Navigator.pop(context, pathCtrl.text.trim()), child: const Text('确定')),
        ],
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

    if (ctrl.config.serverUrl.isEmpty || ctrl.config.token.isEmpty) {
      _showSnack('请填写主端地址和 Token');
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

        return Scaffold(
          appBar: AppBar(
            leadingWidth: 96,
            leading: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: '重置设置',
                  icon: const Icon(Icons.restart_alt),
                  onPressed: () => _resetSettings(ctrl),
                ),
                IconButton(
                  tooltip: '保存设置',
                  icon: const Icon(Icons.save_outlined),
                  onPressed: () => _saveAndNotify(ctrl),
                ),
              ],
            ),
            title: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ZephyrMark(palette: _palette, size: 26),
                const SizedBox(width: 8),
                const Text('Zephyr Agent', style: TextStyle(fontWeight: FontWeight.w700)),
              ],
            ),
            actions: [
              PopupMenuButton<ZephyrTheme>(
                icon: Icon(Icons.palette, color: accent),
                onSelected: widget.onThemeChanged,
                itemBuilder: (_) => ZephyrTheme.values.map((t) => PopupMenuItem(
                  value: t,
                  child: Row(children: [
                    ZephyrMark(
                      palette: ZephyrColors.palette(t, brightness),
                      size: 22,
                    ),
                    const SizedBox(width: 8),
                    Text(t.label),
                    if (t == widget.currentTheme) ...[
                      const Spacer(),
                      Icon(Icons.check, size: 18, color: accent),
                    ],
                  ]),
                )).toList(),
              ),
            ],
          ),
          // Bottom-center grey version from compile-time release tag
          // (agent-v1.0.12 → v1.0.12). Not interactive.
          bottomNavigationBar: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 10, top: 4),
              child: Text(
                AgentVersion.tag,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w400,
                  letterSpacing: 0.2,
                  color: _palette.textSecondary.withValues(alpha: 0.72),
                ),
              ),
            ),
          ),
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Status card
                _buildStatusCard(ctrl, accent),
                const SizedBox(height: 16),

                // Connection form
                _buildFormCard(ctrl, isActive, accent),
                const SizedBox(height: 16),

                // Directory & permissions
                _buildDirectoryCard(ctrl, isActive, accent),
                const SizedBox(height: 16),

                // Auto-shutdown
                _buildShutdownCard(ctrl, accent),
                const SizedBox(height: 16),

                // Transfer stats
                if (ctrl.transferCount > 0)
                  _buildStatsCard(ctrl, accent),

                const SizedBox(height: 24),

                // Action buttons
                if (!isActive)
                  SizedBox(
                    height: 50,
                    child: ElevatedButton.icon(
                      onPressed: () => _startConnection(ctrl),
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('启动连接'),
                    ),
                  )
                else ...[
                  SizedBox(
                    height: 50,
                    child: OutlinedButton.icon(
                      onPressed: () => ctrl.stop(),
                      icon: const Icon(Icons.stop),
                      label: const Text('停止共享'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: _palette.danger,
                        side: BorderSide(color: _palette.danger.withValues(alpha: 0.5)),
                      ),
                    ),
                  ),
                  if (ctrl.config.autoShutdown && ctrl.shutdownAt != null) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      height: 42,
                      child: TextButton.icon(
                        onPressed: () => ctrl.extendShutdown(),
                        icon: const Icon(Icons.timer, size: 18),
                        label: Text('延长 ${ctrl.config.autoShutdownMinutes} 分钟'),
                      ),
                    ),
                  ],
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildStatusCard(AgentController ctrl, Color accent) {
    final status = ctrl.status;
    Color dotColor;
    switch (status) {
      case AgentStatus.online:
        dotColor = _palette.success;
        break;
      case AgentStatus.connecting:
      case AgentStatus.authenticating:
      case AgentStatus.reconnecting:
        dotColor = _palette.warning;
        break;
      case AgentStatus.error:
        dotColor = _palette.danger;
        break;
      default:
        dotColor = _palette.textSecondary;
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              width: 12, height: 12,
              decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(status.label,
                    style: TextStyle(fontWeight: FontWeight.w600, color: dotColor, fontSize: 15)),
                  if (ctrl.errorMessage.isNotEmpty)
                    Text(ctrl.errorMessage,
                      style: TextStyle(color: _palette.textSecondary, fontSize: 12),
                      maxLines: 2, overflow: TextOverflow.ellipsis),
                  if (ctrl.agentId != null)
                    Text('Agent: ${ctrl.agentId}',
                      style: TextStyle(color: _palette.textSecondary, fontSize: 11)),
                ],
              ),
            ),
            if (ctrl.config.autoShutdown && ctrl.shutdownAt != null && ctrl.status == AgentStatus.online)
              _buildCountdown(ctrl),
          ],
        ),
      ),
    );
  }

  Widget _buildCountdown(AgentController ctrl) {
    final remaining = ctrl.remainingShutdownTime;
    if (remaining == null) return const SizedBox.shrink();
    final m = remaining.inMinutes;
    final s = remaining.inSeconds % 60;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: _palette.surface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}',
        style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w600, fontSize: 16),
      ),
    );
  }

  Widget _buildFormCard(AgentController ctrl, bool isActive, Color accent) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('连接设置', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
            const SizedBox(height: 12),
            TextField(
              controller: _urlCtrl,
              enabled: !isActive,
              decoration: const InputDecoration(
                labelText: '主端地址',
                hintText: 'https://example.com',
                prefixIcon: Icon(Icons.link, size: 20),
              ),
              keyboardType: TextInputType.url,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _tokenCtrl,
              enabled: !isActive,
              obscureText: true,
              decoration: const InputDecoration(
                labelText: 'Token',
                prefixIcon: Icon(Icons.key, size: 20),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _nameCtrl,
              enabled: !isActive,
              decoration: const InputDecoration(
                labelText: '设备名称',
                prefixIcon: Icon(Icons.devices, size: 20),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDirectoryCard(AgentController ctrl, bool isActive, Color accent) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('共享目录', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
            const SizedBox(height: 12),
            InkWell(
              onTap: isActive ? null : () => _pickDirectory(ctrl),
              borderRadius: BorderRadius.circular(8),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: _palette.surface,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    Icon(Icons.folder, color: accent),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        ctrl.config.sharedDirectoryPath ?? '点击选择共享目录',
                        style: TextStyle(
                          color: ctrl.config.sharedDirectoryPath != null
                              ? _palette.text
                              : _palette.textSecondary,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (!isActive) Icon(Icons.chevron_right, color: _palette.textSecondary),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                const Text('权限：', style: TextStyle(fontSize: 13)),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: const Text('只读'),
                  selected: ctrl.config.readOnly,
                  onSelected: isActive ? null : (v) {
                    setState(() => ctrl.config.readOnly = true);
                    _saveConfig(ctrl);
                  },
                ),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: const Text('读写'),
                  selected: !ctrl.config.readOnly,
                  onSelected: isActive ? null : (v) {
                    setState(() => ctrl.config.readOnly = false);
                    _saveConfig(ctrl);
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildShutdownCard(AgentController ctrl, Color accent) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Icon(Icons.timer_outlined, color: accent, size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                '${ctrl.config.autoShutdownMinutes} 分钟后自动关闭共享',
                style: const TextStyle(fontSize: 14),
              ),
            ),
            Switch(
              value: ctrl.config.autoShutdown,
              onChanged: ctrl.status.isActive ? null : (v) {
                setState(() => ctrl.config.autoShutdown = v);
                _saveConfig(ctrl);
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatsCard(AgentController ctrl, Color accent) {
    String bytesStr;
    final bytes = ctrl.transferBytes;
    if (bytes < 1024) {
      bytesStr = '$bytes B';
    } else if (bytes < 1024 * 1024) {
      bytesStr = '${(bytes / 1024).toStringAsFixed(1)} KB';
    } else {
      bytesStr = '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(Icons.swap_vert, color: accent, size: 20),
            const SizedBox(width: 12),
            Text('${ctrl.transferCount} 次请求'),
            const SizedBox(width: 16),
            Text(bytesStr, style: TextStyle(color: accent, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
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
      ..moveTo(p(45, 65).dx, p(45, 65).dy)
      ..cubicTo(p(85, 45).dx, p(85, 45).dy, p(135, 55).dx, p(135, 55).dy, p(160, 80).dx, p(160, 80).dy)
      ..cubicTo(p(130, 80).dx, p(130, 80).dy, p(95, 95).dx, p(95, 95).dy, p(75, 125).dx, p(75, 125).dy);
    final mid = Path()
      ..moveTo(p(50, 75).dx, p(50, 75).dy)
      ..cubicTo(p(90, 75).dx, p(90, 75).dy, p(125, 90).dx, p(125, 90).dy, p(145, 115).dx, p(145, 115).dy)
      ..cubicTo(p(115, 135).dx, p(115, 135).dy, p(75, 155).dx, p(75, 155).dy, p(40, 135).dx, p(40, 135).dy);
    final tail = Path()
      ..moveTo(p(85, 95).dx, p(85, 95).dy)
      ..cubicTo(p(110, 110).dx, p(110, 110).dy, p(135, 135).dx, p(135, 135).dy, p(155, 130).dx, p(155, 130).dy);

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
    canvas.drawCircle(p(75, 125), 3 * size.width / 200, Paint()..color = palette.iconDotB.withValues(alpha: .8));
  }

  @override
  bool shouldRepaint(covariant _ZephyrMarkPainter oldDelegate) => oldDelegate.palette != palette;
}
