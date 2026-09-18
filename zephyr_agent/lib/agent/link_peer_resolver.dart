import 'dart:io';

/// Turns a Link peer URL into IP literals plus the original hostname.
///
/// Mirrors Android LinkPeerResolver: the embedded Go core is CGO_ENABLED=0
/// and has no cgo DNS. Resolve here, then tell Go to connect to each IP
/// while keeping the original hostname for TLS SNI / HTTP Host.
class LinkPeerTarget {
  final String url;
  final String serverName;
  const LinkPeerTarget(this.url, this.serverName);
}

Future<List<LinkPeerTarget>> resolveLinkPeers(String serverUrl) async {
  final uri = Uri.parse(serverUrl);
  final host = uri.host;
  if (host.isEmpty) throw ArgumentError('Link URL missing host');
  if (_isLiteralIp(host)) return [LinkPeerTarget(serverUrl, host)];
  final addresses = await InternetAddress.lookup(host);
  final ips = <String>{};
  for (final addr in addresses) {
    final ip = addr.address.split('%').first;
    if (ip.isNotEmpty) ips.add(ip);
  }
  if (ips.isEmpty) throw SocketException('Failed host lookup: $host');
  final ordered = ips.toList()
    ..sort((a, b) {
      final a6 = a.contains(':');
      final b6 = b.contains(':');
      if (a6 != b6) return a6 ? 1 : -1;
      return a.compareTo(b);
    });
  return ordered.map((ip) => _rewrite(uri, host, ip)).toList();
}

LinkPeerTarget _rewrite(Uri uri, String serverName, String ip) {
  final encoded = ip.contains(':') ? '[$ip]' : ip;
  final rewritten = uri.replace(host: encoded.contains('[') ? ip : ip);
  // Uri.replace with IPv6 needs the host without brackets; Dart adds them.
  return LinkPeerTarget(rewritten.toString(), serverName);
}

bool _isLiteralIp(String host) {
  final value = host.replaceAll('[', '').replaceAll(']', '');
  if (value.contains(':')) return true;
  final parts = value.split('.');
  if (parts.length != 4) return false;
  return parts.every((part) {
    final n = int.tryParse(part);
    return n != null && n >= 0 && n <= 255;
  });
}
