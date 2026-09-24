const sentinelSchemaVersion = 1;
const sentinelRuleSetVersion = 'sentinel-rules.v1.0.0';

const sentinelDirections = <String>[
  'input',
  'tool_result',
  'output',
  'speak_pass',
  'memory',
];

const sentinelCategories = <String>[
  'self_harm',
  'violence',
  'illegal',
  'pii',
  'child_safety',
  'sexual_content',
  'medical_guardrail',
  'jailbreak_attempt',
  'harmless',
];

const sentinelSeverities = <String>['low', 'medium', 'high'];

const sentinelAdvisoryMessage =
    'Local safety advisory: this message matched a safety rule and will still be sent.';

class SentinelRuleContext {
  const SentinelRuleContext({this.requires, this.excludes});

  final List<String>? requires;
  final List<String>? excludes;

  factory SentinelRuleContext.fromJson(Object? value) {
    final map = _record(value, 'context');
    return SentinelRuleContext(
      requires: _optionalStringList(map['requires'], 'context.requires'),
      excludes: _optionalStringList(map['excludes'], 'context.excludes'),
    );
  }
}

class SentinelRule {
  const SentinelRule({
    required this.id,
    required this.category,
    required this.severity,
    required this.patterns,
    this.context,
  });

  final String id;
  final String category;
  final String severity;
  final List<String> patterns;
  final SentinelRuleContext? context;

  factory SentinelRule.fromJson(Object? value) {
    final map = _record(value, 'rule');
    final id = _requiredString(map['id'], 'rule.id');
    final category = _requiredString(map['category'], 'rule.category');
    final severity = _requiredString(map['severity'], 'rule.severity');
    if (!sentinelCategories.contains(category)) {
      throw FormatException('rule.category is unknown');
    }
    if (!sentinelSeverities.contains(severity)) {
      throw FormatException('rule.severity is unknown');
    }
    if (map['match'] != null && map['match'] != 'phrase') {
      throw FormatException('rule.match must be phrase');
    }
    return SentinelRule(
      id: id,
      category: category,
      severity: severity,
      patterns: _requiredStringList(map['patterns'], 'rule.patterns'),
      context: map['context'] == null
          ? null
          : SentinelRuleContext.fromJson(map['context']),
    );
  }
}

class SentinelRuleSet {
  const SentinelRuleSet({
    required this.schemaVersion,
    required this.version,
    required this.rules,
  });

  final int schemaVersion;
  final String version;
  final List<SentinelRule> rules;

  factory SentinelRuleSet.fromJson(Object? value) {
    final map = _record(value, 'rule set');
    if (map['schemaVersion'] != sentinelSchemaVersion) {
      throw FormatException('unsupported rule set schema version');
    }
    final version = _requiredString(map['version'], 'rule set version');
    final rawRules = map['rules'];
    if (rawRules is! List) throw FormatException('rules must be an array');
    final seen = <String>{};
    final rules = <SentinelRule>[];
    for (final raw in rawRules) {
      final rule = SentinelRule.fromJson(raw);
      if (!seen.add(rule.id)) {
        throw FormatException('duplicate rule id ${rule.id}');
      }
      rules.add(rule);
    }
    return SentinelRuleSet(
      schemaVersion: sentinelSchemaVersion,
      version: version,
      rules: List.unmodifiable(rules),
    );
  }
}

class SentinelFinding {
  const SentinelFinding({
    required this.ruleId,
    required this.category,
    required this.severity,
  });

  final String ruleId;
  final String category;
  final String severity;
}

class SentinelAdvisory {
  const SentinelAdvisory({
    required this.findings,
    required this.categories,
    required this.severity,
    required this.ruleSetVersion,
    required this.sourceSha256,
    this.normalizationComplete = true,
  });

  final List<SentinelFinding> findings;
  final List<String> categories;
  final String? severity;
  final String ruleSetVersion;
  final String sourceSha256;
  final bool normalizationComplete;

  bool get hasFinding =>
      findings.isNotEmpty || !normalizationComplete;
}

Map<String, Object?> _record(Object? value, String path) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, value) => MapEntry(key.toString(), value));
  }
  throw FormatException('$path must be an object');
}

String _requiredString(Object? value, String path) {
  if (value is String && value.trim().isNotEmpty) return value;
  throw FormatException('$path must be a non-empty string');
}

List<String> _requiredStringList(Object? value, String path) {
  if (value is! List || value.isEmpty) {
    throw FormatException('$path must be a non-empty array');
  }
  return List.unmodifiable(
    value.map((entry) {
      if (entry is! String || entry.trim().isEmpty) {
        throw FormatException('$path must contain non-empty strings');
      }
      return entry;
    }),
  );
}

List<String>? _optionalStringList(Object? value, String path) {
  if (value == null) return null;
  return _requiredStringList(value, path);
}
