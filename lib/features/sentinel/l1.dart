import 'data/rules.generated.dart';
import 'nfkc.dart';
import 'types.dart';

List<SentinelFinding> evaluateL1(String text, {SentinelRuleSet? ruleSet}) {
  final rules = ruleSet ?? generatedSentinelRuleSet;
  if (text.trim().isEmpty) return const [];
  final findings = <SentinelFinding>[];
  for (final rule in rules.rules) {
    if (!_matchesRule(rule, text)) continue;
    findings.add(
      SentinelFinding(
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
      ),
    );
  }
  findings.sort((left, right) => left.ruleId.compareTo(right.ruleId));
  return List.unmodifiable(findings);
}

bool _matchesRule(SentinelRule rule, String text) {
  final patternMatches = rule.patterns.any(
    (pattern) => containsNormalizedPhrase(text, pattern),
  );
  if (!patternMatches) return false;
  final context = rule.context;
  if (context?.requires != null &&
      !context!.requires!.every(
        (phrase) => containsNormalizedPhrase(text, phrase),
      )) {
    return false;
  }
  if (context?.excludes?.any(
        (phrase) => containsNormalizedPhrase(text, phrase),
      ) ??
      false) {
    return false;
  }
  return true;
}

class SentinelInputGate {
  SentinelInputGate({
    SentinelRuleSet? ruleSet,
    String? sourceSha256,
    String? expectedVersion,
  }) : ruleSet = ruleSet ?? generatedSentinelRuleSet,
       sourceSha256 = sourceSha256 ?? generatedSentinelRuleSetSourceSha256,
       expectedVersion = expectedVersion ?? sentinelRuleSetVersion {
    if (ruleSet == null && this.ruleSet.version != this.expectedVersion) {
      throw StateError('sentinel rule set version is not supported');
    }
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(this.sourceSha256)) {
      throw StateError('sentinel rule set hash is invalid');
    }
  }

  final SentinelRuleSet ruleSet;
  final String sourceSha256;
  final String expectedVersion;

  List<SentinelFinding> evaluate(String text) =>
      evaluateL1(text, ruleSet: ruleSet);

  SentinelAdvisory? advisory(String text) {
    final findings = evaluate(text);
    final normalization = normalizeSentinelTextResult(text);
    if (findings.isEmpty && normalization.complete) return null;
    final categories = <String>[];
    for (final category in sentinelCategories) {
      if (findings.any((finding) => finding.category == category)) {
        categories.add(category);
      }
    }
    String? severity;
    for (final finding in findings) {
      if (severity == null ||
          _severityRank(finding.severity) > _severityRank(severity)) {
        severity = finding.severity;
      }
    }
    return SentinelAdvisory(
      findings: findings,
      categories: List.unmodifiable(categories),
      severity: severity,
      ruleSetVersion: ruleSet.version,
      sourceSha256: sourceSha256,
      normalizationComplete: normalization.complete,
    );
  }
}

int _severityRank(String severity) {
  switch (severity) {
    case 'low':
      return 0;
    case 'medium':
      return 1;
    case 'high':
      return 2;
    default:
      return -1;
  }
}

final sentinelInputGate = SentinelInputGate();
