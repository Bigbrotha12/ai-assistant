import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/agent_config.dart';
import '../data/plugin_catalog_providers.dart';
import '../data/plugin_credentials_providers.dart';

class AgentEditorScreen extends ConsumerStatefulWidget {
  const AgentEditorScreen({
    super.key,
    this.existing,
  });

  final AgentConfig? existing;

  @override
  ConsumerState<AgentEditorScreen> createState() => _AgentEditorScreenState();
}

class _AgentEditorScreenState extends ConsumerState<AgentEditorScreen> {
  final _nameController = TextEditingController();
  final _descriptionController = TextEditingController();
  final _systemPromptController = TextEditingController();
  bool _busy = false;
  String? _error;

  Set<String> _selectedSkills = {};
  Set<String> _selectedMcps = {};

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
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    _descriptionController.dispose();
    _systemPromptController.dispose();
    super.dispose();
  }

  String _generateId(String name) {
    final slug = name
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
        .replaceAll(RegExp(r'^-|-$'), '');
    return slug.isEmpty ? 'agent-${DateTime.now().millisecondsSinceEpoch}' : slug;
  }

  Future<void> _save() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Name is required.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final id = widget.existing?.id ?? _generateId(name);
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
      );
      final creds = ref.read(scopedPluginCredentialsProvider);
      await creds.setAgentConfig(id, config);
      await creds.setSelectedAgent(id);
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Could not save agent. Check your account and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final skills = ref.watch(skillsCatalogProvider);
    final mcps = ref.watch(mcpsCatalogProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.existing != null ? 'Edit Agent' : 'New Agent'),
        actions: [
          FilledButton(
            onPressed: _busy ? null : _save,
            child: const Text('Save'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _nameController,
            enabled: !_busy,
            decoration: const InputDecoration(
              labelText: 'Agent name',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
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
            controller: _systemPromptController,
            enabled: !_busy,
            maxLines: 6,
            decoration: const InputDecoration(
              labelText: 'System prompt',
              hintText: 'You are a helpful assistant...',
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
          if (_busy) const LinearProgressIndicator(),
          if (_error != null)
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
            ),
        ],
      ),
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
            ? Text(skill['description'] as String, maxLines: 1, overflow: TextOverflow.ellipsis)
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
            ? Text(mcp['description'] as String, maxLines: 1, overflow: TextOverflow.ellipsis)
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
}