import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb, visibleForTesting;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'backend_settings.dart';
import 'config.dart';

/// Individual backend endpoint probed by [BackendProbe.probe].
enum BackendCheck { tokenMint, tokenMintAuth, liveKit, llmProxy }

/// Human-readable label for a [BackendCheck], used by the settings screen.
extension BackendCheckLabel on BackendCheck {
  String get label => switch (this) {
        BackendCheck.tokenMint => 'Token mint',
        BackendCheck.tokenMintAuth => 'Shared secret',
        BackendCheck.liveKit => 'LiveKit signaling',
        BackendCheck.llmProxy => 'LLM proxy',
      };
}

/// Verdict for a single check.
enum ProbeStatus { ok, error, unreachable }

/// Outcome of probing one backend endpoint.
class CheckResult {
  const CheckResult({
    required this.check,
    required this.status,
    required this.detail,
  });

  final BackendCheck check;
  final ProbeStatus status;
  final String detail;
}

/// Aggregated probe result over the full backend chain.
class BackendStatus {
  const BackendStatus({required this.checks});

  final List<CheckResult> checks;

  /// Result for [check], or null when the probe didn't run it.
  CheckResult? resultFor(BackendCheck check) {
    for (final result in checks) {
      if (result.check == check) return result;
    }
    return null;
  }

  /// True when at least one check ran and every check succeeded.
  bool get allOk =>
      checks.isNotEmpty && checks.every((c) => c.status == ProbeStatus.ok);
}

/// Creates a WebSocket connection attempt (injectable for tests).
typedef WebSocketConnector = Future<WebSocketChannel> Function(Uri uri);

/// Test-only override for the web platform.
///
/// `kIsWeb` is a compile-time constant, so the web-specific failure
/// classification cannot be exercised from VM tests without this hook. It
/// defaults to [kIsWeb] and is never set in production code.
@visibleForTesting
bool debugWebPlatform = kIsWeb;

/// Probes reachability and readiness of the backend voice stack.
abstract interface class BackendProbe {
  /// Probes the full backend chain concurrently; results ordered
  /// [BackendCheck.tokenMint, tokenMintAuth, liveKit, llmProxy].
  Future<BackendStatus> probe(BackendSettings settings);
}

/// [BackendProbe] over HTTP (token-mint, LLM proxy) and WebSocket (LiveKit).
class DioBackendProbe implements BackendProbe {
  DioBackendProbe({
    Dio? dio,
    WebSocketConnector? wsConnector,
    Duration tokenMintTimeout = const Duration(seconds: 8),
    Duration liveKitTimeout = const Duration(seconds: 8),
    Duration llmTimeout = const Duration(seconds: 25),
  })  : _dio = dio ??
            Dio(
              BaseOptions(
                connectTimeout: const Duration(seconds: 8),
                receiveTimeout: const Duration(seconds: 8),
              ),
            ),
        _wsConnector = wsConnector ?? _connect,
        _timeouts = (
          tokenMint: tokenMintTimeout,
          liveKit: liveKitTimeout,
          llm: llmTimeout,
        );

  final Dio _dio;
  final WebSocketConnector _wsConnector;
  final ({Duration tokenMint, Duration liveKit, Duration llm}) _timeouts;

  @override
  Future<BackendStatus> probe(BackendSettings settings) async {
    final results = await Future.wait([
      _probeTokenMint(settings),
      _probeTokenMintAuth(settings),
      _probeLiveKit(settings),
      _probeLlmProxy(settings),
    ]);
    return BackendStatus(checks: results);
  }

  Future<CheckResult> _probeTokenMint(BackendSettings settings) {
    final host = settings.trimmedHost;
    return _guard(BackendCheck.tokenMint, () async {
      final resp = await _dio
          .getUri(BackendConfig.tokenMintHealthz(host))
          .timeout(_timeouts.tokenMint);
      final body = resp.data;
      if (resp.statusCode == 200 && body is Map && body['status'] == 'ok') {
        return const CheckResult(
          check: BackendCheck.tokenMint,
          status: ProbeStatus.ok,
          detail: 'reachable',
        );
      }
      return CheckResult(
        check: BackendCheck.tokenMint,
        status: ProbeStatus.error,
        detail: _truncate('HTTP ${resp.statusCode}: $body'),
      );
    });
  }

  Future<CheckResult> _probeTokenMintAuth(BackendSettings settings) {
    final host = settings.trimmedHost;
    return _guard(
      BackendCheck.tokenMintAuth,
      () async {
        final resp = await _dio
            .postUri(
              BackendConfig.tokenMintToken(host),
              data: {
                'identity': 'mobile-probe',
                'room': 'voicebot-room',
                'name': 'Mobile',
              },
              options: Options(
                headers: {'Authorization': 'Bearer ${settings.secret}'},
                // The bearer secret must never be replayed to a redirect
                // target on another origin.
                followRedirects: false,
              ),
            )
            .timeout(_timeouts.tokenMint);
        if (resp.statusCode == 200) {
          return const CheckResult(
            check: BackendCheck.tokenMintAuth,
            status: ProbeStatus.ok,
            detail: 'shared secret valid',
          );
        }
        return CheckResult(
          check: BackendCheck.tokenMintAuth,
          status: ProbeStatus.error,
          detail: 'HTTP ${resp.statusCode}',
        );
      },
      httpError: _tokenMintAuthHttpDetail,
    );
  }

  Future<CheckResult> _probeLiveKit(BackendSettings settings) async {
    try {
      final channel = await _wsConnector(
        BackendConfig.liveKitWs(settings.trimmedHost),
      ).timeout(_timeouts.liveKit);
      try {
        await channel.sink.close();
      } catch (_) {
        // Best-effort close; the server may already have closed the socket.
      }
      return const CheckResult(
        check: BackendCheck.liveKit,
        status: ProbeStatus.ok,
        detail: 'signaling reachable',
      );
    } catch (e) {
      final (status, detail) = _classify(e);
      return CheckResult(
        check: BackendCheck.liveKit,
        status: status,
        detail: detail,
      );
    }
  }

  Future<CheckResult> _probeLlmProxy(BackendSettings settings) {
    final host = settings.trimmedHost;
    return _guard(
      BackendCheck.llmProxy,
      () async {
        final resp = await _dio
            .postUri(
              BackendConfig.llmCompletions(host),
              data: {
                'messages': [
                  {'role': 'user', 'content': 'ping'},
                ],
                'max_tokens': 1,
                'stream': false,
              },
            )
            .timeout(_timeouts.llm);
        if (resp.statusCode == 200) {
          return const CheckResult(
            check: BackendCheck.llmProxy,
            status: ProbeStatus.ok,
            detail: 'inference ready',
          );
        }
        return CheckResult(
          check: BackendCheck.llmProxy,
          status: ProbeStatus.error,
          detail: 'HTTP ${resp.statusCode}',
        );
      },
      httpError: _llmProxyHttpDetail,
    );
  }

  /// Runs [run], translating non-2xx responses into error results and every
  /// other failure through [_classify]. [httpError] customizes the detail for
  /// HTTP error responses of the probe at hand.
  Future<CheckResult> _guard(
    BackendCheck check,
    Future<CheckResult> Function() run, {
    String Function(DioException error)? httpError,
  }) async {
    try {
      return await run();
    } on DioException catch (e) {
      if (e.type == DioExceptionType.badResponse) {
        final detail = httpError?.call(e) ??
            'HTTP ${e.response?.statusCode}: ${e.response?.data}';
        return CheckResult(
          check: check,
          status: ProbeStatus.error,
          detail: _truncate(detail),
        );
      }
      final (status, detail) = _classify(e);
      return CheckResult(check: check, status: status, detail: detail);
    } catch (e) {
      final (status, detail) = _classify(e);
      return CheckResult(check: check, status: status, detail: detail);
    }
  }

  static String _tokenMintAuthHttpDetail(DioException e) {
    final code = e.response?.statusCode;
    return switch (code) {
      401 => 'shared secret rejected (401)',
      403 => '403: reserved identity or unknown room',
      503 => 'server not ready (503)',
      _ => 'HTTP $code',
    };
  }

  static String _llmProxyHttpDetail(DioException e) {
    final code = e.response?.statusCode;
    return switch (code) {
      503 => 'RabbitMQ not reachable (503)',
      502 || 504 => 'backend not ready ($code)',
      400 || 422 => 'proxy returned $code (unexpected request shape)',
      _ => 'HTTP $code',
    };
  }

  /// Whether failures should be classified the way the web platform surfaces
  /// them (see [_classify]).
  bool get _webPlatform => debugWebPlatform || kIsWeb;

  /// Classifies a failure into (status, detail) by walking the wrapped-cause
  /// chain. Network-family failures (dio timeouts/connection errors,
  /// SocketException, TimeoutException) map to unreachable. A
  /// [WebSocketChannelException] that is not a network failure proves the
  /// signaling endpoint answered, so it maps to ok. Anything else is an error
  /// carrying its own detail.
  (ProbeStatus, String) _classify(Object error) {
    var current = error;
    for (var depth = 0; depth < 8; depth++) {
      if (current is SocketException || current is TimeoutException) {
        return (ProbeStatus.unreachable, 'unreachable');
      }
      if (current is DioException) {
        if (current.type == DioExceptionType.connectionTimeout ||
            current.type == DioExceptionType.sendTimeout ||
            current.type == DioExceptionType.receiveTimeout ||
            current.type == DioExceptionType.connectionError) {
          return (ProbeStatus.unreachable, 'unreachable');
        }
        if (current.error case final inner?) {
          current = inner;
          continue;
        }
        return (ProbeStatus.error, _truncate('$current'));
      }
      if (current is WebSocketChannelException) {
        if (_webPlatform) {
          // On the web the HTML channel surfaces every connect failure
          // (browser DomException/ErrorEvent-style causes, or a bare
          // 'WebSocket connection failed.') as a WebSocketChannelException with
          // no explicit "server rejected the upgrade" marker, so any such
          // exception means the host was never reached.
          return (ProbeStatus.unreachable, 'unreachable');
        }
        final inner = current.inner;
        if (inner == null || inner is WebSocketException) {
          // The server answered but rejected the upgrade (e.g. no token
          // provided), which still proves the signaling endpoint is up.
          return (ProbeStatus.ok, 'signaling reachable (server responded)');
        }
        current = inner;
        continue;
      }
      if (_webPlatform) {
        // Any other browser-level failure (DomException, ErrorEvent, ...) is
        // a network failure on web, since no upgrade-rejection marker exists.
        return (ProbeStatus.unreachable, 'unreachable');
      }
      return (ProbeStatus.error, _truncate('$current'));
    }
    return (ProbeStatus.error, _truncate('$current'));
  }

  /// Caps the raw body/error text embedded in a [CheckResult.detail] so huge
  /// responses do not blow up the settings screen.
  static String _truncate(Object? text, [int limit = 120]) {
    final s = '$text';
    if (s.length <= limit) return s;
    return '${s.substring(0, limit)}…';
  }

  /// Default connector: connects and waits for the handshake so failures
  /// surface here instead of as unhandled stream errors.
  static Future<WebSocketChannel> _connect(Uri uri) async {
    final channel = WebSocketChannel.connect(uri);
    await channel.ready;
    return channel;
  }
}