import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/agent_config.dart';
import '../data/plugin_catalog_providers.dart';
import '../data/plugin_credentials_providers.dart';
import '../data/plugin_dto.dart';

/// Client mirrors of the gateway's `customAgentSpecSchema` caps so an
/// over-cap agent fails fast in the editor instead of 400ing on send.
const _maxSystemPromptLength = 8000;
const _maxSkillCount = 50;
const _maxMcpCount = 20;
const _maxToolCount = 100;
const _maxTokenLimit = 200000;
const _maxTemperature = 2.0;
const _pluginCatalogLoadingMessage = 'Loading plugins…';
const _pluginCatalogUnavailableMessage =
    "Plugin catalog unavailable — can't validate this agent yet";

class AgentEditorScreen extends ConsumerStatefulWidget {
  const AgentEditorScreen({super.key, this.existing});

  final AgentConfig? existing;

  @override
  ConsumerState<AgentEditorScreen> createState() => _AgentEditorScreenState();
}

class _AgentEditorScreenState extends ConsumerState<AgentEditorScreen> {
  final _nameController = TextEditingController();
  final _descriptionController = TextEditingController();
  final _systemPromptController = TextEditingController();
  final _maxTokensController = TextEditingController();
  bool _busy = false;
  String? _error;

  Set<String> _selectedSkills = {};
  Set<String> _selectedMcps = {};
  Set<String> _selectedTools = {};
  final Map<String, bool> _toolRequired = {};
  String? _modelRef;
  double _temperature = 1.0;
  bool _temperatureTouched = false;
  bool _visionCapable = false;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    if (existing != null) {
      _nameController.text = existing.name;
      _descriptionController.text = existing.description ?? '';
      _systemPromptController.text = existing.systemPrompt ?? '';
      _selectedSkills = existing.skills.toSet();
      _selectedMcps = existing.mcpServers.toSet();
      _selectedTools = existing.tools.map((tool) => tool.pluginId).toSet();
      for (final tool in existing.tools) {
        _toolRequired[tool.pluginId] = tool.required;
      }
      _modelRef = existing.modelRef;
      final inference = existing.inference;
      if (inference?.temperature != null) {
        _temperature = inference!.temperature!;
        _temperatureTouched = true;
      }
      if (inference?.maxTokens != null) {
        _maxTokensController.text = inference!.maxTokens.toString();
      }
      _visionCapable = inference?.visionCapable ?? false;
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    _descriptionController.dispose();
    _systemPromptController.dispose();
    _maxTokensController.dispose();
    super.dispose();
  }

  String _generateId(String name) {
    final slug = name
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
        .replaceAll(RegExp(r'^-|-$'), '');
    return slug.isEmpty
        ? 'agent-${DateTime.now().millisecondsSinceEpoch}'
        : slug;
  }

  String? _catalogMessage({
    required bool isLoading,
    required bool hasError,
    required PluginCatalog? value,
  }) {
    if (isLoading) return _pluginCatalogLoadingMessage;
    if (hasError || value == null) return _pluginCatalogUnavailableMessage;
    return null;
  }

  ({String? error, int? maxTokens}) _validated() {
    if (_nameController.text.trim().isEmpty) {
      return (error: 'Name is required.', maxTokens: null);
    }
    if (_systemPromptController.text.trim().length > _maxSystemPromptLength) {
      return (
        error:
            'System prompt must be $_maxSystemPromptLength characters or fewer.',
        maxTokens: null,
      );
    }
    if (_selectedSkills.length > _maxSkillCount) {
      return (error: 'Select at most $_maxSkillCount skills.', maxTokens: null);
    }
    if (_selectedMcps.length > _maxMcpCount) {
      return (
        error: 'Select at most $_maxMcpCount MCP servers.',
        maxTokens: null,
      );
    }
    if (_selectedTools.length > _maxToolCount) {
      return (error: 'Select at most $_maxToolCount tools.', maxTokens: null);
    }
    if (_temperature < 0 || _temperature > _maxTemperature) {
      return (
        error: 'Temperature must be between 0 and $_maxTemperature.',
        maxTokens: null,
      );
    }
    final rawTokens = _maxTokensController.text.trim();
    int? maxTokens;
    if (rawTokens.isNotEmpty) {
      final parsed = int.tryParse(rawTokens);
      if (parsed == null || parsed < 1 || parsed > _maxTokenLimit) {
        return (
          error:
              'Max tokens must be a whole number between 1 and $_maxTokenLimit.',
          maxTokens: null,
        );
      }
      maxTokens = parsed;
    }
    final catalogState = ref.read(pluginCatalogProvider);
    final catalogMessage = _catalogMessage(
      isLoading: catalogState.isLoading,
      hasError: catalogState.hasError,
      value: catalogState.value,
    );
    if (catalogMessage != null) {
      return (error: catalogMessage, maxTokens: null);
    }
    final catalog = catalogState.requireValue;
    if (_modelRef != null &&
        !catalog.models.any((model) => model.id == _modelRef)) {
      return (
        error: 'Selected model is not an installed model plugin.',
        maxTokens: null,
      );
    }
    final installedToolIds = catalog.plugins
        .where(
          (plugin) =>
              plugin.type == 'tool' && plugin.installed && plugin.isSupported,
        )
        .map((plugin) => plugin.id)
        .toSet();
    if (_selectedTools.any((id) => !installedToolIds.contains(id))) {
      return (
        error: 'Tool grants must reference installed tool plugins.',
        maxTokens: null,
      );
    }
    return (error: null, maxTokens: maxTokens);
  }

  Future<void> _save() async {
    final (:error, :maxTokens) = _validated();
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final name = _nameController.text.trim();
      final id = widget.existing?.id ?? _generateId(name);
      final temperature = _temperatureTouched
          ? _temperature.clamp(0.0, 2.0).toDouble()
          : null;
      final config = AgentConfig(
        id: id,
        kind: AgentKind.custom,
        name: name,
        description: _descriptionController.text.trim().isEmpty
            ? null
            : _descriptionController.text.trim(),
        systemPrompt: _systemPromptController.text.trim().isEmpty
            ? null
            : _systemPromptController.text.trim(),
        skills: _selectedSkills.toList()..sort(),
        mcpServers: _selectedMcps.toList()..sort(),
        tools: [
          for (final toolId in _selectedTools.toList()..sort())
            AgentToolGrantData(
              pluginId: toolId,
              required: _toolRequired[toolId] ?? false,
            ),
        ],
        modelRef: _modelRef,
        inference: (temperature != null || maxTokens != null || _visionCapable)
            ? AgentInferenceData(
                temperature: temperature,
                maxTokens: maxTokens,
                visionCapable: _visionCapable,
              )
            : null,
      );
      // Re-read the provider before each write: the scoped provider is
      // autoDispose and its `_invalidate()` bumps the credentials epoch, which
      // invalidates the provider instance we hold. Reading it fresh per write
      // avoids handing a stale instance (unmounted ref / stale epoch) to the
      // next `_write`, which would throw PluginReauthenticationRequired.
      await ref
          .read(scopedPluginCredentialsProvider)
          .setAgentConfig(id, config);
      await ref.read(scopedPluginCredentialsProvider).setSelectedAgent(id);
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      setState(
        () =>
            _error = 'Could not save agent. Check your account and try again.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Keep a live subscription on the scoped handle: `_write`'s `_invalidate()`
    // only bumps the credentials epoch while this provider's ref is mounted.
    // A bare `ref.read` would let the autoDispose instance die mid-await, so
    // the epoch never advances and the plugins list stays stale after save.
    ref.watch(scopedPluginCredentialsProvider);
    final skills = ref.watch(skillsCatalogProvider);
    final mcps = ref.watch(mcpsCatalogProvider);
    final catalog = ref.watch(pluginCatalogProvider);
    final catalogValue = catalog.value;
    final catalogMessage = _catalogMessage(
      isLoading: catalog.isLoading,
      hasError: catalog.hasError,
      value: catalogValue,
    );
    final toolPlugins = catalogValue == null
        ? const <PluginDto>[]
        : catalogValue.plugins
              .where(
                (plugin) =>
                    plugin.type == 'tool' &&
                    plugin.installed &&
                    plugin.isSupported,
              )
              .toList();
    final models = catalogValue?.models ?? const <PluginModelDto>[];

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.existing != null ? 'Edit Agent' : 'New Agent'),
        actions: [
          FilledButton(
            onPressed: _busy || catalogMessage != null ? null : _save,
            child: const Text('Save'),
          ),

          const SizedBox(width: 8),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (catalogMessage != null)
            Padding(
              key: const Key('agent-catalog-status'),
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(catalogMessage),
            ),
          TextField(
            key: const Key('agent-name'),
            controller: _nameController,
            enabled: !_busy,
            decoration: const InputDecoration(
              labelText: 'Agent name',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('agent-description'),
            controller: _descriptionController,
            enabled: !_busy,
            maxLines: 2,
            decoration: const InputDecoration(
              labelText: 'Description (optional)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('agent-system-prompt'),
            controller: _systemPromptController,
            enabled: !_busy,
            maxLines: 6,
            decoration: const InputDecoration(
              labelText: 'System prompt',
              hintText: 'You are a helpful assistant...',
              helperText: 'Up to 8000 characters',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          Text('Skills', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          if (skills.isLoading)
            const Text('Loading skills...')
          else if (skills.hasError)
            const Text('Could not load skills.')
          else if (skills.value?.isEmpty ?? true)
            const Text('No skills available.')
          else
            ..._buildSkillTiles(skills.requireValue),
          const SizedBox(height: 16),
          Text('MCP Servers', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          if (mcps.isLoading)
            const Text('Loading MCP servers...')
          else if (mcps.hasError)
            const Text('Could not load MCP servers.')
          else if (mcps.value?.isEmpty ?? true)
            const Text('No MCP servers available.')
          else
            ..._buildMcpTiles(mcps.requireValue),
          const SizedBox(height: 16),
          Text('Tools', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          if (catalog.isLoading && catalogValue == null)
            const Text('Loading tools...')
          else if (catalogValue == null)
            const Text('Could not load tools.')
          else if (toolPlugins.isEmpty)
            const Text('No tool plugins available.')
          else
            ..._buildToolTiles(toolPlugins),
          const SizedBox(height: 16),
          Text('Model', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          _buildModelField(models, catalogValue),
          const SizedBox(height: 16),
          Text('Inference', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Row(
            children: [
              Text(
                'Temperature: ${_temperature.toStringAsFixed(1)}',
                key: const Key('agent-temperature-value'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          Slider(
            key: const Key('agent-temperature'),
            value: _temperature,
            min: 0,
            max: 2,
            divisions: 20,
            label: _temperature.toStringAsFixed(1),
            onChanged: _busy
                ? null
                : (value) => setState(() {
                    _temperature = value;
                    _temperatureTouched = true;
                  }),
          ),
          const SizedBox(height: 4),
          TextField(
            key: const Key('agent-max-tokens'),
            controller: _maxTokensController,
            enabled: !_busy,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(
              labelText: 'Max tokens (optional)',
              hintText: 'Provider default when blank',
              helperText: 'Whole number up to 200000',
              border: OutlineInputBorder(),
            ),
          ),
          SwitchListTile(
            key: const Key('agent-vision'),
            contentPadding: EdgeInsets.zero,
            title: const Text('Vision capable'),
            subtitle: const Text('Let this agent describe attached images'),
            value: _visionCapable,
            onChanged: _busy
                ? null
                : (value) => setState(() => _visionCapable = value),
          ),
          if (_busy) const LinearProgressIndicator(),
          if (_error != null)
            Semantics(
              key: const Key('agent-error'),
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildModelField(List<PluginModelDto> models, PluginCatalog? catalog) {
    return DropdownButtonFormField<String?>(
      key: const Key('agent-model'),
      initialValue: _modelRef,
      decoration: const InputDecoration(
        labelText: 'Model (optional)',
        helperText: 'Overrides the account model for this agent',
        border: OutlineInputBorder(),
      ),
      items: [
        const DropdownMenuItem<String?>(
          value: null,
          child: Text('(Account default)'),
        ),
        for (final model in models)
          DropdownMenuItem<String?>(
            value: model.id,
            child: Text(catalog?.installedPlugin(model.id)?.name ?? model.id),
          ),
        if (_modelRef != null && !models.any((model) => model.id == _modelRef))
          DropdownMenuItem<String?>(
            value: _modelRef,
            child: Text(
              catalog == null ? _modelRef! : '$_modelRef (unavailable)',
            ),
          ),
      ],
      onChanged: catalog == null || _busy
          ? null
          : (value) => setState(() => _modelRef = value),
    );
  }

  List<Widget> _buildSkillTiles(List<Map<String, dynamic>> skills) {
    return skills.map((skill) {
      final id = (skill['id'] as String? ?? '');
      final title = (skill['title'] as String? ?? id);
      final selected = _selectedSkills.contains(id);
      return CheckboxListTile(
        key: ValueKey('skill-$id'),
        value: selected,
        title: Text(title),
        subtitle: skill['description'] != null
            ? Text(
                skill['description'] as String,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              )
            : null,
        dense: true,
        controlAffinity: ListTileControlAffinity.leading,
        onChanged: _busy
            ? null
            : (checked) {
                if (checked == null) return;
                setState(() {
                  if (checked) {
                    _selectedSkills.add(id);
                  } else {
                    _selectedSkills.remove(id);
                  }
                });
              },
      );
    }).toList();
  }

  List<Widget> _buildMcpTiles(List<Map<String, dynamic>> mcps) {
    return mcps.map((mcp) {
      final name = (mcp['name'] as String? ?? '');
      final selected = _selectedMcps.contains(name);
      return CheckboxListTile(
        key: ValueKey('mcp-$name'),
        value: selected,
        title: Text(name.isNotEmpty ? name : (mcp['id'] as String? ?? '')),
        subtitle: mcp['description'] != null
            ? Text(
                mcp['description'] as String,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              )
            : null,
        dense: true,
        controlAffinity: ListTileControlAffinity.leading,
        onChanged: _busy
            ? null
            : (checked) {
                if (checked == null) return;
                setState(() {
                  if (checked) {
                    _selectedMcps.add(name);
                  } else {
                    _selectedMcps.remove(name);
                  }
                });
              },
      );
    }).toList();
  }

  List<Widget> _buildToolTiles(List<PluginDto> tools) {
    return tools.map((tool) {
      final selected = _selectedTools.contains(tool.id);
      return CheckboxListTile(
        key: ValueKey('tool-${tool.id}'),
        value: selected,
        title: Text(tool.name),
        subtitle: Text(
          tool.description,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        dense: true,
        controlAffinity: ListTileControlAffinity.leading,
        onChanged: _busy
            ? null
            : (checked) {
                if (checked == null) return;
                setState(() {
                  if (checked) {
                    _selectedTools.add(tool.id);
                    _toolRequired.putIfAbsent(tool.id, () => false);
                  } else {
                    _selectedTools.remove(tool.id);
                  }
                });
              },
      );
    }).toList();
  }
}
