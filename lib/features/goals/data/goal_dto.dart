import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';

/// Goal wire models — the client half of `WIRE_SPEC §12`.
///
/// Parsing rule: the identity fields a caller keys on ([GoalSubmitted.goalId],
/// [GoalDetail.goalId] + [GoalDetail.status]) are REQUIRED — a payload without
/// them is a protocol error (`PluginProtocolException` → `invalid_response`).
/// Everything §12 marks nullable, or that the server derives from a JSON
/// column (`todos`, `steps`, the pause/failure fields), defaults instead of
/// throwing: the server parses those columns defensively for the same reason
/// (a malformed row must not 500 the read), and a todo view must never go down
/// because one optional entry is malformed.

/// `POST /v1/goals` → `201` (also the `200` idempotent re-get shape).
class GoalSubmitted {
  const GoalSubmitted({
    required this.goalId,
    required this.status,
    required this.todos,
    required this.createdAt,
  });

  factory GoalSubmitted.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    return GoalSubmitted(
      goalId: pluginJsonString(json['goalId']),
      status: pluginJsonString(json['status']),
      todos: parseGoalTodos(json['todos']),
      createdAt: pluginJsonString(json['createdAt']),
    );
  }

  final String goalId;
  final String status;

  /// The plan the server already carries (empty at admission — `update_plan`
  /// fills it in as the goal runs).
  final List<String> todos;
  final String createdAt;
}

/// One `steps` entry of `GET /v1/goals/:id`.
class GoalStep {
  const GoalStep({
    required this.seq,
    required this.kind,
    required this.status,
    required this.tokens,
  });

  factory GoalStep.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    return GoalStep(
      seq: _int(json['seq']),
      kind: _stringOr(json['kind'], ''),
      status: _stringOr(json['status'], ''),
      tokens: _int(json['tokens']),
    );
  }

  final int seq;
  final String kind;
  final String status;
  final int tokens;
}

/// One `unresolvedMutations` entry of `GET /v1/goals/:id` (Phase 6's resume
/// input — parsed now so the model is the full §12 shape).
class GoalMutation {
  const GoalMutation({required this.tool, required this.argsHash});

  factory GoalMutation.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    return GoalMutation(
      tool: pluginJsonString(json['tool']),
      argsHash: pluginJsonString(json['argsHash']),
    );
  }

  final String tool;
  final String argsHash;
}

/// `GET /v1/goals/:id` (`WIRE_SPEC §12`).
class GoalDetail {
  const GoalDetail({
    required this.goalId,
    required this.status,
    required this.pauseReason,
    required this.pauseQuestion,
    required this.resultSummary,
    required this.failureReason,
    required this.instruction,
    required this.todos,
    required this.tokenBudget,
    required this.tokensSpent,
    required this.effectState,
    required this.canCancel,
    required this.canResume,
    required this.terminal,
    required this.unresolvedMutations,
    required this.steps,
    required this.updatedAt,
  });

  factory GoalDetail.fromJson(Object? value) {
    final json = pluginJsonObject(value);
    return GoalDetail(
      goalId: pluginJsonString(json['goalId']),
      status: pluginJsonString(json['status']),
      pauseReason: _nullableString(json['pauseReason']),
      pauseQuestion: _nullableString(json['pauseQuestion']),
      resultSummary: _nullableString(json['resultSummary']),
      failureReason: _nullableString(json['failureReason']),
      instruction: _stringOr(json['instruction'], ''),
      todos: parseGoalTodos(json['todos']),
      tokenBudget: _int(json['tokenBudget']),
      tokensSpent: _int(json['tokensSpent']),
      effectState: _stringOr(json['effectState'], ''),
      canCancel: json['canCancel'] == true,
      canResume: json['canResume'] == true,
      terminal: json['terminal'] == true,
      unresolvedMutations: _parseList(json['unresolvedMutations'], GoalMutation.fromJson),
      steps: _parseList(json['steps'], GoalStep.fromJson),
      updatedAt: _stringOr(json['updatedAt'], ''),
    );
  }

  final String goalId;

  /// One of `queued|running|paused|complete|failed|cancelled`.
  final String status;
  final String? pauseReason;
  final String? pauseQuestion;
  final String? resultSummary;
  final String? failureReason;
  final String instruction;

  /// The ordered plan — a `List<String>` because `update_plan` (the control
  /// tool that writes it) takes `z.array(z.string())`. Non-string entries are
  /// dropped rather than fatal.
  final List<String> todos;
  final int tokenBudget;
  final int tokensSpent;
  final String effectState;
  final bool canCancel;
  final bool canResume;
  final bool terminal;
  final List<GoalMutation> unresolvedMutations;
  final List<GoalStep> steps;
  final String updatedAt;
}

/// Defensive `todos` read: only `String` entries survive, mirroring the
/// server's `parseJsonArray` (a malformed row can never break the read).
List<String> parseGoalTodos(Object? value) {
  if (value is! List) return const [];
  return List.unmodifiable(value.whereType<String>());
}

List<T> _parseList<T>(Object? value, T Function(Object?) parse) {
  if (value is! List) return const [];
  final parsed = <T>[];
  for (final entry in value) {
    try {
      parsed.add(parse(entry));
    } on PluginProtocolException {
      // One malformed entry must not take the whole view down.
    }
  }
  return List.unmodifiable(parsed);
}

String? _nullableString(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

String _stringOr(Object? value, String fallback) =>
    value is String ? value : fallback;

int _int(Object? value) => value is int && value >= 0 ? value : 0;
