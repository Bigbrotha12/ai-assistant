import 'dart:async';
import 'dart:convert';

/// The kind of a parsed [SseEvent].
enum SseEventType { content, toolCall, sentinel, done, error }

/// A single parsed SSE event from an OpenAI-compatible chat stream.
class SseEvent {
  final SseEventType type;
  final String?
  content; // content delta (type == content), thinking already stripped
  final ToolCallDelta? toolCall; // tool-call delta (type == toolCall)
  final SentinelAdvisoryEvent? sentinel; // advisory (type == sentinel)
  final String? finishReason; // 'stop' | 'tool_calls' | null
  final String? error; // set when server sent {"error": "..."} envelope

  const SseEvent.content(this.content)
    : type = SseEventType.content,
      toolCall = null,
      sentinel = null,
      finishReason = null,
      error = null;

  const SseEvent.toolCall(this.toolCall)
    : type = SseEventType.toolCall,
      content = null,
      sentinel = null,
      finishReason = null,
      error = null;

  const SseEvent.sentinel(this.sentinel)
    : type = SseEventType.sentinel,
      content = null,
      toolCall = null,
      finishReason = null,
      error = null;

  const SseEvent.done(this.finishReason)
    : type = SseEventType.done,
      content = null,
      toolCall = null,
      sentinel = null,
      error = null;

  const SseEvent.error(this.error)
    : type = SseEventType.error,
      content = null,
      toolCall = null,
      sentinel = null,
      finishReason = null;
}

/// Which stage of the server's two-phase Sentinel advisory produced a frame.
/// The initial L1 frame leads a finding turn; a later semantic frame (when the
/// semantic stage answered) carries the authoritative verdict. A legacy P3
/// frame carries no phase and is treated as a final L1 advisory.
enum SentinelPhase { l1, semantic }

/// One detector hit carried on a [SentinelAdvisoryEvent]. `source` records the
/// producing stage and `confidence` the model probability (semantic only), so
/// the two layers stay auditable side by side.
class SentinelFinding {
  const SentinelFinding({
    required this.ruleId,
    required this.category,
    this.severity,
    required this.source,
    this.confidence,
  });

  final String ruleId;
  final String category;
  final String? severity;

  /// 'l1' or 'semantic'.
  final String source;

  /// Model probability in 0..1 (semantic findings only); null for L1.
  final double? confidence;
}

/// The server's input-safety advisory for a managed turn, parsed from a
/// standalone `sentinel` SSE frame. The gateway emits the initial L1 frame
/// (`phase:"l1"`, provisional) when its L1 gate matched the user's input, then
/// one later semantic frame (`phase:"semantic"`, `final:true`) before
/// finish/DONE when the semantic stage answered. A semantic-clean frame
/// (`advisory:false`) clears any provisional L1 notice; if no semantic frame
/// arrives the L1 notice is retained. A legacy P3 frame carries no
/// `phase`/`source` and parses as a final L1 advisory. No frame means no
/// advisory. The turn still streams normally — the frames are informational and
/// never block the request.
class SentinelAdvisoryEvent {
  const SentinelAdvisoryEvent({
    required this.categories,
    required this.severity,
    required this.matchedRules,
    this.phase = SentinelPhase.l1,
    this.isFinal = true,
    this.advisory = true,
    this.semanticAvailable = false,
    this.findings = const [],
    this.cannedResponseId,
  });

  final List<String> categories;
  final String? severity;
  final List<String> matchedRules;

  final SentinelPhase phase;

  /// Whether this frame is the turn's terminal advisory (a semantic frame, or a
  /// legacy P3 frame). A provisional L1 frame is not final.
  final bool isFinal;

  /// Whether the advisory is active. `false` (semantic-clean) instructs the UI
  /// to clear a provisional L1 notice; such a frame only exists in the semantic
  /// phase.
  final bool advisory;

  /// Whether the semantic stage produced this verdict rather than falling back
  /// to L1.
  final bool semanticAvailable;

  final List<SentinelFinding> findings;

  /// Advisory canned-response id from `action.cannedResponseId`, or null.
  final String? cannedResponseId;
}

/// User-facing copy for the dismissible advisory banner / voice notice shown
/// when [SentinelAdvisoryEvent] arrives.
const sentinelAdvisoryNotice =
    'Safety advisory: this message matched a safety rule and will still be sent.';

SentinelAdvisoryEvent? _parseSentinelAdvisory(Object? value) {
  if (value is! Map) return null;
  final rawPhase = value['phase'];
  final rawSource = value['source'];
  final hasPhase = rawPhase is String || rawSource is String;
  final phase =
      _sentinelPhaseOf(rawPhase) ??
      _sentinelPhaseOf(rawSource) ??
      SentinelPhase.l1;
  final advisory = value['advisory'] == true;
  // A provisional/legacy L1 frame only ever exists on a finding turn
  // (`advisory:true`); a non-advisory one carries nothing to show. The semantic
  // phase also arrives clean (`advisory:false`) to clear a provisional L1
  // notice, so it always surfaces.
  if (phase == SentinelPhase.l1 && !advisory) return null;

  final findings = _parseSentinelFindings(value['findings']);
  final categories = _stringList(value['categories']);
  final matchedRules = _stringList(value['matchedRules']);
  return SentinelAdvisoryEvent(
    phase: phase,
    // A legacy P3 frame (no phase) is the terminal L1 verdict; a phase-tagged
    // frame is final only when it says so (the semantic frame).
    isFinal: value['final'] == true || !hasPhase,
    advisory: advisory,
    semanticAvailable: value['semanticAvailable'] == true,
    categories: categories.isNotEmpty
        ? categories
        : _distinct(findings.map((finding) => finding.category)),
    severity: value['severity'] is String
        ? value['severity'] as String
        : _highestSeverity(findings),
    matchedRules: matchedRules.isNotEmpty
        ? matchedRules
        : _distinct(findings.map((finding) => finding.ruleId)),
    findings: findings,
    cannedResponseId: _cannedResponseId(value['action']),
  );
}

SentinelPhase? _sentinelPhaseOf(Object? value) => switch (value) {
  'l1' => SentinelPhase.l1,
  'semantic' => SentinelPhase.semantic,
  _ => null,
};

List<SentinelFinding> _parseSentinelFindings(Object? value) {
  if (value is! List) return const [];
  final findings = <SentinelFinding>[];
  for (final entry in value) {
    if (entry is! Map) continue;
    findings.add(
      SentinelFinding(
        ruleId: entry['ruleId'] is String ? entry['ruleId'] as String : '',
        category: entry['category'] is String
            ? entry['category'] as String
            : '',
        severity: entry['severity'] is String
            ? entry['severity'] as String
            : null,
        source: entry['source'] == 'semantic' ? 'semantic' : 'l1',
        confidence: entry['confidence'] is num
            ? (entry['confidence'] as num).toDouble()
            : null,
      ),
    );
  }
  return List.unmodifiable(findings);
}

String? _cannedResponseId(Object? action) {
  if (action is! Map) return null;
  final id = action['cannedResponseId'];
  return id is String && id.isNotEmpty ? id : null;
}

const _severityRank = {'low': 0, 'medium': 1, 'high': 2};

String? _highestSeverity(List<SentinelFinding> findings) {
  String? highest;
  var rank = -1;
  for (final finding in findings) {
    final candidate = _severityRank[finding.severity];
    if (candidate != null && candidate > rank) {
      rank = candidate;
      highest = finding.severity;
    }
  }
  return highest;
}

List<String> _distinct(Iterable<String> values) {
  final seen = <String>{};
  final distinct = <String>[];
  for (final value in values) {
    if (value.isEmpty) continue;
    if (seen.add(value)) distinct.add(value);
  }
  return List.unmodifiable(distinct);
}

List<String> _stringList(Object? value) {
  if (value is! List) return const [];
  return List.unmodifiable(value.whereType<String>());
}

/// An incremental tool-call delta for one call index.
class ToolCallDelta {
  const ToolCallDelta({
    required this.index,
    this.id, // set on first fragment
    this.name, // set on first fragment
    required this.argsFragment, // incremental argument text (accumulate raw)
  });

  final int index;
  final String? id;
  final String? name;
  final String argsFragment;
}

/// Parses an SSE byte stream into events.
Stream<SseEvent> parseSse(Stream<List<int>> byteStream) async* {
  const decoder = Utf8Decoder(allowMalformed: true);
  final lines = decoder.bind(byteStream).transform(const LineSplitter());

  final seenIndexes = <int>{};
  final startedArgs = <int>{};
  String? finishReason;

  await for (final line in lines) {
    if (line.isEmpty) continue;
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;

    final payload = line.substring(5).trim();
    if (payload.isEmpty) continue;

    if (payload == '[DONE]') {
      yield SseEvent.done(finishReason);
      return;
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(payload);
    } on FormatException {
      continue;
    }

    if (decoded is! Map<String, dynamic>) continue;

    final sentinel = decoded['sentinel'];
    if (sentinel != null) {
      final advisory = _parseSentinelAdvisory(sentinel);
      if (advisory != null) yield SseEvent.sentinel(advisory);
      continue;
    }

    final choices = decoded['choices'];
    if (choices is! List || choices.isEmpty) {
      final error = decoded['error'];
      if (error != null) {
        yield SseEvent.error(_errorMessage(error));
        return;
      }
      continue;
    }

    final choice = choices.first;
    if (choice is! Map<String, dynamic>) continue;

    final delta = choice['delta'];
    if (delta is Map<String, dynamic>) {
      final content = delta['content'];
      if (content is String && content.isNotEmpty) {
        final stripped = _stripThinking(content);
        if (stripped.isNotEmpty) {
          yield SseEvent.content(stripped);
        }
      }

      final toolCalls = delta['tool_calls'];
      if (toolCalls is List) {
        for (final toolCall in toolCalls) {
          if (toolCall is! Map<String, dynamic>) continue;
          final index = toolCall['index'];
          final callIndex = index is int ? index : 0;
          final isFirst = seenIndexes.add(callIndex);

          String? name;
          String? rawFragment;
          final function = toolCall['function'];
          if (function is Map<String, dynamic>) {
            final fname = function['name'];
            if (fname is String) name = fname;
            final fargs = function['arguments'];
            if (fargs is String) rawFragment = fargs;
          }

          final id = toolCall['id'];
          final fragment = rawFragment ?? '';
          // llama.cpp fragmentation workaround: the first argument fragment
          // may arrive without its leading `{`. Re-prefix it so concatenated
          // fragments form valid JSON. The decision only ever needs to know
          // whether a non-empty fragment was already emitted for this index:
          // once one has been, the accumulated args begin with `{`, so no
          // later fragment is re-prefixed.
          final needsBracePrefix =
              !startedArgs.contains(callIndex) &&
              fragment.isNotEmpty &&
              !fragment.startsWith('{');
          final emittedFragment = needsBracePrefix ? '{$fragment' : fragment;
          if (fragment.isNotEmpty) startedArgs.add(callIndex);

          final emittedId = isFirst && id is String ? id : null;
          final emittedName = isFirst ? name : null;
          if (emittedId != null ||
              emittedName != null ||
              emittedFragment.isNotEmpty) {
            yield SseEvent.toolCall(
              ToolCallDelta(
                index: callIndex,
                id: emittedId,
                name: emittedName,
                argsFragment: emittedFragment,
              ),
            );
          }
        }
      }
    }

    final rawFinishReason = choice['finish_reason'];
    if (rawFinishReason is String &&
        rawFinishReason.isNotEmpty &&
        finishReason == null) {
      finishReason = rawFinishReason;
    }
  }

  yield SseEvent.done(finishReason);
}

final _thinkingBlock = RegExp(r'<thinking>[\s\S]*?</thinking>');
final _thinkingTag = RegExp(r'</?thinking>');

String _stripThinking(String content) {
  var result = content
      .replaceAll(_thinkingBlock, '')
      .replaceAll(_thinkingTag, '');
  return stripStructuredTokens(result);
}

/// Strips structured-output control tokens emitted by the inference API.
///
/// The model frames tool / citation references with Private Use Area (PUA)
/// sentinels (`\uE200`–`\uE202` …), e.g. `\ue200cite\ue202turn0file0\ue201` or
/// a bare tool reference `\ue202turn0search0`. These are machine markers that
/// must never surface in a rendered bubble, and they can be split across SSE
/// deltas, so callers strip on both per-delta content and the accumulated
/// buffer.
String stripStructuredTokens(String content) {
  if (!content.contains(RegExp(r'[\uE000-\uF8FF]'))) return content;
  // A PUA sentinel plus its reference payload: either a `turn<N><tool><N>`
  // tool/citation reference (e.g. `turn0search0`, `turn0file0`) or a short
  // lowercase block keyword (`cite`). Bounded so a following real word is
  // never clipped (non-greedy lowercase-only payload).
  return content.replaceAll(
    RegExp(r'[\uE000-\uF8FF](?:turn\d+[a-z]+\d*|[a-z]+)?'),
    '',
  );
}

String _errorMessage(Object? error) {
  return switch (error) {
    final String s => s,
    final Map m => m['message'] is String ? m['message'] as String : '$error',
    _ => '$error',
  };
}
