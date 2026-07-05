import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:file_picker/file_picker.dart';
import '../agent/agent_controller.dart';
import '../agent/agent_state.dart';
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

  void _saveConfig(AgentController ctrl) {
    ctrl.config.serverUrl = _urlCtrl.text.trim();
    ctrl.config.token = _tokenCtrl.text.trim();
    ctrl.config.deviceName = _nameCtrl.text.trim();
    ctrl.updateConfig(ctrl.config);
    LocalSettings.saveConfig(ctrl.config);
  }

  Future<void> _pickDirectory(AgentController ctrl) async {
    final result = await FilePicker.platform.getDirectoryPath(
      dialogTitle: '选择共享目录',
    );
    if (result != null) {
      setState(() {
        ctrl.config.sharedDirectoryPath = result;
        ctrl.config.sharedDirectoryName = result.split('/').last.split('\\').last;
      });
      _saveConfig(ctrl);
    }
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

    ctrl.setFileProvider(DesktopFileProvider(ctrl.config.sharedDirectoryPath!));
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
        final accent = ZephyrColors.getPrimary(widget.currentTheme);

        return Scaffold(
          appBar: AppBar(
            title: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.hub, color: accent, size: 24),
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
                    Container(
                      width: 16, height: 16,
                      decoration: BoxDecoration(
                        color: ZephyrColors.getPrimary(t),
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(t.name[0].toUpperCase() + t.name.substring(1)),
                    if (t == widget.currentTheme) ...[
                      const Spacer(),
                      Icon(Icons.check, size: 18, color: accent),
                    ],
                  ]),
                )).toList(),
              ),
            ],
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
                        foregroundColor: ZephyrColors.error,
                        side: BorderSide(color: ZephyrColors.error.withValues(alpha: 0.5)),
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
        dotColor = ZephyrColors.success;
        break;
      case AgentStatus.connecting:
      case AgentStatus.authenticating:
      case AgentStatus.reconnecting:
        dotColor = ZephyrColors.warning;
        break;
      case AgentStatus.error:
        dotColor = ZephyrColors.error;
        break;
      default:
        dotColor = ZephyrColors.onSurfaceVariant;
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
                      style: TextStyle(color: ZephyrColors.onSurfaceVariant, fontSize: 12),
                      maxLines: 2, overflow: TextOverflow.ellipsis),
                  if (ctrl.agentId != null)
                    Text('Agent: ${ctrl.agentId}',
                      style: const TextStyle(color: ZephyrColors.onSurfaceVariant, fontSize: 11)),
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
        color: ZephyrColors.surfaceVariant,
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
                hintText: 'wss://example.com',
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
                  color: ZephyrColors.surfaceVariant,
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
                              ? ZephyrColors.onSurface
                              : ZephyrColors.onSurfaceVariant,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (!isActive) Icon(Icons.chevron_right, color: ZephyrColors.onSurfaceVariant),
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
