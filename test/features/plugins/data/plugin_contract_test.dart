import 'dart:convert';
import 'dart:io';

import 'package:ai_assistant/features/plugins/data/plugin_dto.dart';
import 'package:flutter_test/flutter_test.dart';

/// Wire-shape contract check (plan §5, task 0.4b).
///
/// Parses the SAME golden fixture the server asserts in
/// `server/test/transport/contract.test.ts` with the matching Dart parsers.
/// Drift on either side of the wire fails a test.
///
/// Flutter tests run with the package root (repo root) as CWD, so the fixture
/// resolves at its repo-root-relative path.
void main() {
  late Map<String, dynamic> golden;

  setUpAll(() {
    final file = File('test/fixtures/plugin_contract.json');
    expect(
      file.existsSync(),
      isTrue,
      reason: 'missing golden at ${file.absolute.path} (CWD=${Directory.current.path})',
    );
    golden = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  });

  group('plugin_contract.json — PluginDto.parseList', () {
    test('parses one tool, one model and one agent summary without throwing', () {
      final plugins = PluginDto.parseList(golden);
      expect(plugins, hasLength(3));

      final tool = plugins.singleWhere((p) => p.id == 'vikunja');
      expect(tool.type, 'tool');
      expect(tool.isSupported, isTrue);
      expect(tool.tools, hasLength(1));
      expect(tool.tools.single.name, 'list_tasks');
      expect(tool.tools.single.readOnly, isTrue);
      expect(tool.inference, isNull);
      expect(tool.baseUrls.single.id, 'vikunja-api');
      expect(tool.baseUrls.single.url, isNull, reason: 'summary shape is redacted');

      final model = plugins.singleWhere((p) => p.id == 'openrouter');
      expect(model.type, 'model');
      expect(model.isSupported, isTrue);
      expect(model.inference, isNotNull);
      expect(model.inference!.defaultModel, 'openrouter/auto');
      expect(model.inference!.tokenLimit, 131072);
      expect(model.inference!.supportsStreaming, isTrue);
      expect(model.inference!.visionCapable, isTrue);
      expect(model.inference!.endpoint, isNull, reason: 'summary shape is redacted');

      final agent = plugins.singleWhere((p) => p.id == 'kitchen-copilot');
      expect(agent.type, 'agent');
      expect(agent.isSupported, isTrue);
      expect(agent.tools, isEmpty);
      expect(agent.inference, isNull);
    });

    test('credentials round-trip as spec-only (label/required)', () {
      final openrouter = PluginDto.parseList(
        golden,
      ).singleWhere((p) => p.id == 'openrouter');
      expect(openrouter.credentials, isNotNull);
      expect(openrouter.credentials!.label, 'OpenRouter API key');
      expect(openrouter.credentials!.required, isTrue);

      final vikunja = PluginDto.parseList(
        golden,
      ).singleWhere((p) => p.id == 'vikunja');
      expect(vikunja.credentials!.label, 'Vikunja token');
      expect(vikunja.credentials!.required, isTrue);
    });
  });

  group('plugin_contract.json — PluginModelDto.parseList', () {
    test('parses the model list and round-trips a load-bearing entry', () {
      final models = PluginModelDto.parseList(golden['models']);
      expect(models, hasLength(1));

      final model = models.single;
      expect(model.id, 'openrouter');
      expect(model.created, 1700000000);
      expect(model.ownedBy, 'plugin');
      expect(model.defaultModel, 'openrouter/auto');
      expect(model.tokenLimit, 131072);
      expect(model.visionCapable, isTrue);
      expect(model.supportsStreaming, isTrue);
      expect(model.parameters['temperature'], 0.2);
      expect(model.parameters['maxTokens'], 512);
      expect(model.parameters['nested'], {'keep': true});
    });
  });

  group('plugin_contract.json — AgentDto.parseList', () {
    test('parses the agent list and round-trips a load-bearing entry', () {
      final agents = AgentDto.parseList(golden['agents']);
      expect(agents, hasLength(1));

      final agent = agents.single;
      expect(agent.id, 'kitchen-copilot');
      expect(agent.created, 1700000000);
      expect(agent.ownedBy, 'plugin');
      expect(agent.name, 'Kitchen Copilot');
      expect(agent.description, 'Mealie recipe assistant');
      expect(agent.defaultModel, 'openrouter');
      expect(agent.visionCapable, isTrue);
      expect(agent.temperature, 0.3);
      expect(agent.maxTokens, 2048);
      expect(agent.skillCount, 1);
      expect(agent.toolGrants, hasLength(1));
      expect(agent.toolGrants.single.pluginId, 'mealie');
      expect(agent.toolGrants.single.required, isTrue);
    });

    // Documented drift (do NOT fix here — 0.4 detects drift, it does not change
    // behaviour): the server's AgentSummary also sends `skillIds`, `mcpNames`
    // and `source`, which AgentDto currently ignores. This test pins their
    // presence in the golden so a future parser change is a deliberate one.
    test('golden carries skillIds/mcpNames/source that AgentDto ignores', () {
      final data = golden['agents']['data'] as List<dynamic>;
      final first = data.single as Map<String, dynamic>;
      expect(first['skillIds'], ['recipes']);
      expect(first['mcpNames'], ['recipes-mcp']);
      expect(first['source'], 'template');
    });
  });

  // ---- exact-shape drift gate -------------------------------------------------
  //
  // The parsers above ignore unknown keys, so a purely ADDITIVE server field is
  // invisible here: the golden would be regenerated, the server test would go
  // green, and Dart would keep happily discarding the new field. Pinning the
  // exact key set of every wire shape closes that half of the gate — adding a
  // TS field changes the golden AND fails these assertions until a developer
  // deliberately updates this list together with the Dart parser.
  //
  // The sets are hardcoded on purpose: they are the external contract, not a
  // reflection of either implementation. The three plugin variants legitimately
  // differ (tool emits `tools`, model `inference`, agent `agent`), so each gets
  // its own set rather than one uniform one.
  group('plugin_contract.json — exact key sets (additive-drift gate)', () {
    test('golden root has exactly the expected sections', () {
      _expectExactKeys(golden, _goldenKeys, 'golden root');
    });

    test('each plugin summary carries exactly its variant key set', () {
      final plugins = golden['plugins'] as List<dynamic>;
      for (final entry in plugins) {
        final summary = entry as Map<String, dynamic>;
        final expected = switch (summary['type']) {
          'tool' => _toolPluginKeys,
          'model' => _modelPluginKeys,
          'agent' => _agentPluginKeys,
          final other => throw StateError('unexpected plugin type: $other'),
        };
        _expectExactKeys(summary, expected, 'plugin summary (${summary['type']})');
      }
    });

    test('agent plugin sub-shape carries exactly the expected key set', () {
      final plugins = golden['plugins'] as List<dynamic>;
      final agentSummary = plugins
          .map((entry) => entry as Map<String, dynamic>)
          .singleWhere((summary) => summary['type'] == 'agent');
      _expectExactKeys(
        agentSummary['agent'] as Map<String, dynamic>,
        _agentPluginAgentKeys,
        'plugin summary.agent',
      );
    });

    test('model summary carries exactly the expected key set', () {
      final data = golden['models']['data'] as List<dynamic>;
      _expectExactKeys(
        data.single as Map<String, dynamic>,
        _modelSummaryKeys,
        'model summary',
      );
    });

    test('agent summary carries exactly the expected key set', () {
      final data = golden['agents']['data'] as List<dynamic>;
      _expectExactKeys(
        data.single as Map<String, dynamic>,
        _agentSummaryKeys,
        'agent summary',
      );
    });
  });
}

/// Asserts `node`'s keys match `expected` exactly, reporting both sets sorted
/// so a diff is readable without scanning the source.
void _expectExactKeys(
  Map<String, dynamic> node,
  Set<String> expected,
  String shape,
) {
  expect(
    node.keys.toList()..sort(),
    expected.toList()..sort(),
    reason:
        'the $shape key set drifted. A wire field was added or removed; update '
        'both the shared golden (server + Dart parsers) and this expected set '
        'deliberately.',
  );
}

const Set<String> _goldenKeys = {'plugins', 'models', 'agents'};

const Set<String> _toolPluginKeys = {
  'id',
  'type',
  'name',
  'description',
  'category',
  'version',
  'schemaVersion',
  'installed',
  'baseUrls',
  'tools',
  'credentials',
};

const Set<String> _modelPluginKeys = {
  'id',
  'type',
  'name',
  'description',
  'version',
  'schemaVersion',
  'installed',
  'baseUrls',
  'inference',
  'credentials',
};

const Set<String> _agentPluginKeys = {
  'id',
  'type',
  'name',
  'description',
  'version',
  'schemaVersion',
  'installed',
  'baseUrls',
  'credentials',
  'agent',
};

const Set<String> _agentPluginAgentKeys = {
  'modelRef',
  'toolGrants',
  'temperature',
  'maxTokens',
  'visionCapable',
  'skillCount',
  'mcpServers',
};

const Set<String> _modelSummaryKeys = {
  'id',
  'object',
  'created',
  'owned_by',
  'visionCapable',
  'supportsStreaming',
  'defaultModel',
  'tokenLimit',
  'parameters',
};

const Set<String> _agentSummaryKeys = {
  'id',
  'object',
  'created',
  'owned_by',
  'name',
  'description',
  'defaultModel',
  'visionCapable',
  'temperature',
  'maxTokens',
  'toolGrants',
  'skillCount',
  'skillIds',
  'mcpNames',
  'source',
};
