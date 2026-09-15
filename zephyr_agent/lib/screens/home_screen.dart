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
    final palette = Theme.of(context).brightness == Brightness.dark
        ? ZephyrColors.palette(ZephyrTheme.frost, Brightness.dark)
        : ZephyrColors.palette(ZephyrTheme.frost, Brightness.light);
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

                // Optional bastion advertisement
                _buildBastionCard(ctrl, isActive, accent),
                const SizedBox(height: 16),

                // Encrypted lane status / failure reason
                if (isActive) _buildLinkStatusCard(ctrl, accent),
                if (isActive) const SizedBox(height: 16),

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
              controller: _nameCtrl,
              enabled: !isActive,
              decoration: const InputDecoration(
                labelText: '设备名称',
                prefixIcon: Icon(Icons.devices, size: 20),
              ),
            ),
            const SizedBox(height: 16),
            _buildBindingRow(ctrl, isActive, accent),
          ],
        ),
      ),
    );
  }

  /// Device binding row — the Apple-style replacement for the token field.
  /// Three states: bound / unbound / failed, each with one clear action.
  Widget _buildBindingRow(AgentController ctrl, bool isActive, Color accent) {
    final bound = ctrl.config.accessCredential != null && ctrl.config.accessCredential!.isNotEmpty;
    final failed = ctrl.enrollmentError != null && !bound;
    final label = bound
        ? '已绑定此设备'
        : failed
            ? '绑定失败'
            : ctrl.enrollmentBusy
                ? '等待主端批准…'
                : '未绑定';
    final icon = bound
        ? Icons.check_circle
        : failed
            ? Icons.error_outline
            : Icons.qr_code_2;
    final color = bound
        ? _palette.success
        : failed
            ? _palette.danger
            : accent;

    return Row(
      children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: color)),
              Text(
                bound ? '使用 Zephyr One 设备身份，无需 Token' : '在主端批准后完成加密绑定',
                style: TextStyle(fontSize: 11, color: _palette.textSecondary),
              ),
            ],
          ),
        ),
        if (bound)
          TextButton(
            onPressed: isActive ? null : () async { await ctrl.unbind(); },
            child: const Text('解绑'),
          )
        else
          _buildBindButton(ctrl, isActive, accent),
      ],
    );
  }

  Widget _buildBindButton(AgentController ctrl, bool isActive, Color accent) {
    return FilledButton.tonal(
      onPressed: isActive || ctrl.enrollmentBusy ? null : () => _startEnrollment(ctrl),
      style: FilledButton.styleFrom(
        foregroundColor: accent,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
      ),
      child: ctrl.enrollmentBusy
          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
          : const Text('绑定设备'),
    );
  }

  Future<void> _startEnrollment(AgentController ctrl) async {
    _saveConfig(ctrl);
    ctrl.enroll();
    // Show the bind sheet as soon as the pending enrollment exists; it
    // refreshes on every controller notification.
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => ListenableBuilder(
        listenable: ctrl,
        builder: (dialogContext, _) {
          final info = ctrl.enrollment;
          final busy = ctrl.enrollmentBusy;
          final error = ctrl.enrollmentError;
          return AlertDialog(
            title: Text(info != null ? '等待批准' : (busy ? '创建绑定…' : '绑定结果')),
            content: SizedBox(
              width: 320,
              child: info != null
                  ? _BindSheetBody(info: info)
                  : (error != null
                      ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Icon(Icons.error_outline, color: _palette.danger, size: 32),
                          const SizedBox(height: 8),
                          Text(error, style: TextStyle(fontSize: 13, color: _palette.danger)),
                        ])
                      : (busy
                          ? const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
                          : const Text('绑定完成'))),
            ),
            actions: [
              if (info != null)
                TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('后台等待')),
              if (error != null || !busy)
                FilledButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('好')),
            ],
          );
        },
      ),
    );
    if (ctrl.config.accessCredential != null && ctrl.enrollmentError == null) {
      _showSnack('设备绑定成功');
    }
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
                '${ctrl.config.autoShutdownMinutes} 分钟后自动关闭共享和跳板机',
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

  Widget _buildBastionCard(AgentController ctrl, bool isActive, Color accent) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Icon(Icons.alt_route, color: accent, size: 20),
            const SizedBox(width: 12),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('作为跳板机', style: TextStyle(fontSize: 14)),
                  SizedBox(height: 3),
                  Text('供主端和 One 经此 Agent 中转 SSH', style: TextStyle(fontSize: 11)),
                ],
              ),
            ),
            Switch(
              value: ctrl.config.bastionEnabled,
              onChanged: isActive ? null : (v) {
                setState(() => ctrl.config.bastionEnabled = v);
                _saveConfig(ctrl);
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLinkStatusCard(AgentController ctrl, Color accent) {
    final error = ctrl.linkError;
    final tunnelUp = ctrl.linkTunnelUp;
    if (error.isEmpty && tunnelUp) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Icon(error.isEmpty ? Icons.check_circle : Icons.error_outline,
                color: error.isEmpty ? accent : _palette.danger, size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(error.isEmpty ? '加密通道已建立' : '加密通道未建立', style: const TextStyle(fontSize: 14)),
                  if (error.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(error, style: TextStyle(fontSize: 11, color: _palette.danger)),
                  ],
                ],
              ),
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
