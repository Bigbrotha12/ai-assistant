import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_credentials_providers.dart';
import '../../settings/data/settings_providers.dart';
import '../data/agent_config.dart';
import '../data/plugin_catalog_providers.dart';
import '../data/plugin_credentials_providers.dart';
import '../data/plugin_credentials_store.dart';
import '../data/plugin_dto.dart';
import 'agent_editor_screen.dart';

const _defaultBaseUrlEntry = '__default__';

class PluginsScreen extends StatelessWidget {
  const PluginsScreen({super.key});

  @override
  Widget build(BuildContext context) => _PluginPage(
    title: 'Plugins',
    builder: (catalog, configuration) =>
        _PluginList(catalog: catalog, configuration: configuration),
  );
}

class _PluginPage extends ConsumerWidget {
  const _PluginPage({required this.title, required this.builder});

  final String title;
  final Widget Function(PluginCatalog, PluginAccountConfiguration) builder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final access = ref.watch(pluginAccessProvider);
    Widget body;
    switch (access) {
      case PluginAccess.loading:
        body = const Center(child: CircularProgressIndicator());
      case PluginAccess.signedOut:
        body = const Center(
          child: Text('Sign in from Settings to configure plugins.'),
        );
      case PluginAccess.reauthenticate:
        body = const Center(
          child: Text(
            'Sign in again from Settings to configure plugins for this account.',
          ),
        );
      case PluginAccess.error:
        body = _RetryNotice(
          message: 'Could not load account settings.',
          onRetry: () {
            ref.invalidate(settingsProvider);
            ref.invalidate(authCredentialsProvider);
          },
        );
      case PluginAccess.ready:
        final catalog = ref.watch(pluginCatalogProvider);
        final configuration = ref.watch(pluginCredentialsProvider);
        if (catalog.isLoading || configuration.isLoading) {
          body = const Center(child: CircularProgressIndicator());
        } else if (catalog.hasError || configuration.hasError) {
          body = _RetryNotice(
            message: 'Could not load plugins. Check your connection or sign in again from Settings.',
            onRetry: () {
              ref.invalidate(pluginCatalogProvider);
              ref.invalidate(pluginCredentialsProvider);
            },
          );
        } else {
          body = KeyedSubtree(
            key: ObjectKey(ref.watch(authCredentialsProvider).value),
            child: builder(catalog.requireValue, configuration.requireValue),
          );
        }
    }
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: body,
    );
  }
}

class _RetryNotice extends StatelessWidget {
  const _RetryNotice({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    ),
  );
}

class _PluginList extends ConsumerWidget {
  const _PluginList({required this.catalog, required this.configuration});
  final PluginCatalog catalog;
  final PluginAccountConfiguration configuration;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final modelIds = catalog.models.map((model) => model.id).toSet();
    final selected = configuration.selectedModel;
    final selectedAgent = configuration.selectedAgent;
    final templates = ref.watch(agentTemplatesProvider);
    final customAgents = configuration.plugins.entries
        .where((e) => e.value.agent != null && e.value.agent!.kind == AgentKind.custom)
        .toList();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text(
          'Plugins are installed globally by an administrator. Model selection, tool enablement, and saved keys apply only to your account on this gateway.',
        ),
        const SizedBox(height: 16),
        Text('Models', style: Theme.of(context).textTheme.titleMedium),
        if (modelIds.isEmpty)
          const Text(
            'No models available. Ask your administrator to install a model plugin.',
          ),
        if (selected != null && !modelIds.contains(selected))
          const Text(
            'Your selected model was removed or is unavailable. Select another model.',
          ),
        for (final plugin in catalog.plugins.where(
          (plugin) => modelIds.contains(plugin.id),
        ))
          _tile(
            context,
            plugin,
            selected == plugin.id
                ? 'Selected for this account'
                : plugin.inference!.defaultModel,
          ),
        const SizedBox(height: 16),
        Text('Agents', style: Theme.of(context).textTheme.titleMedium),
        if (catalog.agents.isEmpty &&
            (templates.value == null || templates.requireValue.isEmpty) &&
            customAgents.isEmpty)
          const Text(
            'No agents available. Ask your administrator to install an agent plugin.',
          ),
        if (catalog.agents.isNotEmpty) ...[
          Text('Installed agent plugins:',
              style: Theme.of(context).textTheme.titleSmall),
          for (final agent in catalog.agents)
            _agentTile(context, agent, selectedAgent == agent.id, configuration),
          const SizedBox(height: 12),
        ],
        if (templates.isLoading)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('Loading agent templates...'),
          )
        else if (templates.hasError)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('Could not load agent templates.'),
          )
        else if (templates.value != null && templates.requireValue.isNotEmpty) ...[
          Text('Templates:',
              style: Theme.of(context).textTheme.titleSmall),
          for (final template in templates.requireValue)
            _templateTile(
              context, template, selectedAgent == template['id'],
              onSelect: () async {
                try {
                  await ref.read(scopedPluginCredentialsProvider).setSelectedAgent(template['id'] as String?);
                } catch (_) {
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Could not select template.')),
                  );
                }
              },
              onDeselect: () async {
                try {
                  await ref.read(scopedPluginCredentialsProvider).setSelectedAgent(null);
                } catch (_) {
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Could not deselect template.')),
                  );
                }
              },
            ),
          const SizedBox(height: 12),
        ],
        if (customAgents.isNotEmpty) ...[
          Text('Custom agents:',
              style: Theme.of(context).textTheme.titleSmall),
          for (final entry in customAgents)
            _customAgentTile(
              context, entry.key, entry.value.agent!,
              selectedAgent == entry.key,
              onEdit: () => _openEditAgentEditor(context, entry.key, entry.value.agent!),
              onDelete: () async {
                try {
                  await ref.read(scopedPluginCredentialsProvider).removePlugin(entry.key);
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Removed agent "${entry.value.agent!.name.isNotEmpty ? entry.value.agent!.name : entry.key}"')),
                  );
                } catch (_) {
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Could not remove agent.')),
                  );
                }
              },
            ),
          const SizedBox(height: 12),
        ],
        OutlinedButton.icon(
          onPressed: () => _openNewAgentEditor(context),
          icon: const Icon(Icons.add),
          label: const Text('New Agent'),
        ),
        const SizedBox(height: 12),
        Text('Tools', style: Theme.of(context).textTheme.titleMedium),
        for (final plugin in catalog.plugins.where(
          (plugin) => plugin.type == 'tool',
        ))
          _tile(
            context,
            plugin,
            configuration.plugins[plugin.id]?.enabled == true
                ? 'Enabled for this account'
                : 'Disabled for this account',
          ),
        OutlinedButton(
          onPressed: () => ref.invalidate(pluginCatalogProvider),
          child: const Text('Refresh catalog'),
        ),
      ],
    );
  }

  Widget _agentTile(
    BuildContext context,
    AgentDto agent,
    bool isSelected,
    PluginAccountConfiguration configuration,
  ) =>
      ListTile(
        key: ValueKey('agent-${agent.id}'),
        title: Text(agent.name),
        subtitle: Text(
          isSelected
              ? 'Selected for this account'
              : agent.description,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (agent.skillCount > 0)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Chip(
                  label: Text('${agent.skillCount} skills'),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            const Icon(Icons.chevron_right),
          ],
        ),
        onTap: () => _openAgentEditor(context, agent, configuration),
      );

  Widget _templateTile(
    BuildContext context,
    Map<String, dynamic> template,
    bool isSelected, {
    VoidCallback? onSelect,
    VoidCallback? onDeselect,
  }) {
    final id = template['id'] as String? ?? '';
    final name = template['name'] as String? ?? id;
    final description = template['description'] as String? ?? '';
    final modelRef = template['defaultModel'] as String?;
    final toolCount = template['toolGrants'] is List ? (template['toolGrants'] as List).length : 0;
    final skillCount = template['skillCount'] as int? ?? 0;
    final mcpCount = (template['mcpNames'] as List?)?.length ?? 0;
    return ListTile(
      key: ValueKey('template-$id'),
      title: Text(name),
      subtitle: Text(
        isSelected
            ? 'Selected for this account'
            : description,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (skillCount > 0)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Chip(
                label: Text('$skillCount skills'),
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (mcpCount > 0)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Chip(
                label: Text('$mcpCount MCP'),
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (toolCount > 0)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Chip(
                label: Text('$toolCount tools'),
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (modelRef != null)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Chip(
                label: Text(modelRef, style: const TextStyle(fontSize: 10)),
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (isSelected)
            TextButton(onPressed: onDeselect, child: const Text('Deselect'))
          else
            TextButton(onPressed: onSelect, child: const Text('Select')),
        ],
      ),
    );
  }

  Widget _customAgentTile(
    BuildContext context,
    String pluginId,
    AgentConfig agent,
    bool isSelected, {
    VoidCallback? onEdit,
    VoidCallback? onDelete,
  }) =>
      ListTile(
        key: ValueKey('custom-$pluginId'),
        title: Row(
          children: [
            Text(agent.name.isNotEmpty ? agent.name : pluginId),
            const SizedBox(width: 8),
            Chip(
              label: const Text('Custom'),
              visualDensity: VisualDensity.compact,
              backgroundColor: Theme.of(context).colorScheme.primaryContainer,
            ),
          ],
        ),
        subtitle: Text(
          isSelected
              ? 'Selected for this account'
              : (agent.description ?? 'No description'),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (agent.skills.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Chip(
                  label: Text('${agent.skills.length} skills'),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            if (agent.mcpServers.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: Chip(
                  label: Text('${agent.mcpServers.length} MCP'),
                  visualDensity: VisualDensity.compact,
                ),
              ),
            if (isSelected)
              TextButton(onPressed: onEdit, child: const Text('Edit'))
            else ...[
              TextButton(onPressed: onEdit, child: const Text('Edit')),
              TextButton(onPressed: onDelete, child: const Text('Delete')),
            ],
          ],
        ),
      );

  void _openAgentEditor(
    BuildContext context,
    AgentDto agent,
    PluginAccountConfiguration configuration,
  ) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _PluginPage(
          title: 'Configure agent',
          builder: (catalog, configuration) => _AgentEditor(
            key: ValueKey(agent.id),
            agent: agent,
            configuration: configuration,
          ),
        ),
      ),
    );
  }

  void _openNewAgentEditor(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => const AgentEditorScreen(),
      ),
    );
  }

  void _openEditAgentEditor(BuildContext context, String pluginId, AgentConfig agent) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AgentEditorScreen(existing: agent),
      ),
    );
  }

  Widget _tile(BuildContext context, PluginDto plugin, String subtitle) =>
      ListTile(
        key: ValueKey('plugin-${plugin.id}'),
        title: Text(plugin.name),
        subtitle: Text(
          !plugin.isSupported
              ? 'Unsupported plugin version'
              : !plugin.installed
              ? 'Not installed by administrator'
              : subtitle,
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: !plugin.installed || !plugin.isSupported
            ? null
            : () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => _PluginPage(
                    title: 'Configure plugin',
                    builder: (catalog, configuration) {
                      final current = catalog.installedPlugin(plugin.id);
                      if (current == null ||
                          current.type == 'model' &&
                              !catalog.models.any(
                                (model) => model.id == current.id,
                              )) {
                        return const Center(
                          child: Text(
                            'This plugin was removed or is unavailable. Return to Plugins and refresh the catalog.',
                          ),
                        );
                      }
                      return _PluginEditor(
                        key: ValueKey(current.id),
                        plugin: current,
                        configuration: configuration,
                      );
                    },
                  ),
                ),
              ),
      );
}

class _PluginEditor extends ConsumerStatefulWidget {
  const _PluginEditor({
    super.key,
    required this.plugin,
    required this.configuration,
  });
  final PluginDto plugin;
  final PluginAccountConfiguration configuration;

  @override
  ConsumerState<_PluginEditor> createState() => _PluginEditorState();
}

class _PluginEditorState extends ConsumerState<_PluginEditor> {
  final _keyController = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _keyController.clear();
    _keyController.dispose();
    super.dispose();
  }

  Future<void> _write(
    Future<void> Function(ScopedPluginCredentials) operation,
  ) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await operation(ref.read(scopedPluginCredentialsProvider));
      if (!mounted) return;
      _keyController.clear();
    } catch (_) {
      if (!mounted) return;
      setState(
        () => _error = 'Could not save. Check your account and try again.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(scopedPluginCredentialsProvider);
    final plugin = widget.plugin;
    final saved = widget.configuration.plugins[plugin.id];
    final hasKey = saved?.credentials['apiKey']?.isNotEmpty ?? false;
    final savedEntry = saved?.credentials['baseUrlEntry'];
    final hasBaseUrlOptions = plugin.credentials != null &&
        plugin.type != 'tool' &&
        plugin.baseUrls.isNotEmpty;
    final selectedEntry =
        savedEntry != null &&
            plugin.baseUrls.any((instance) => instance.id == savedEntry)
        ? savedEntry
        : _defaultBaseUrlEntry;
    final defaultBaseUrl =
        '${ref.read(pluginAccountScopeProvider).backendOrigin}/v1';
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(plugin.name, style: Theme.of(context).textTheme.headlineSmall),
        Text(plugin.description),
        const SizedBox(height: 16),
        if (plugin.type == 'model') ...[
          Text('Model: ${plugin.inference!.defaultModel}'),
          if (widget.configuration.selectedModel == plugin.id)
            const Text('Selected for this account')
          else
            FilledButton(
              onPressed: _busy
                  ? null
                  : () => _write((store) => store.setSelectedModel(plugin.id)),
              child: const Text('Select model'),
            ),
        ] else
          SwitchListTile(
            title: const Text('Enable for this account'),
            value: saved?.enabled ?? false,
            onChanged: _busy
                ? null
                : (value) =>
                      _write((store) => store.setEnabled(plugin.id, value)),
          ),
        if (plugin.credentials case final credentials?) ...[
          const SizedBox(height: 16),
          Text(
            hasKey
                ? 'API key saved for this account. Leave blank to keep it.'
                : 'No API key saved for this account.',
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('plugin-api-key'),
            controller: _keyController,
            enabled: !_busy,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.visiblePassword,
            decoration: InputDecoration(
              labelText: credentials.label,
              helperText: credentials.required
                  ? 'Required for this plugin'
                  : 'Optional',
              border: const OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy || _keyController.text.trim().isEmpty
                ? null
                : () {
                    final fields = {
                      ...?saved?.credentials,
                      'apiKey': _keyController.text,
                    };
                    _write((store) => store.setCredentials(plugin.id, fields));
                  },
            child: const Text('Save API key'),
          ),
          if (hasKey)
            TextButton(
              onPressed: _busy
                  ? null
                  : () => _write(
                      (store) => store.setCredentials(
                        plugin.id,
                        {...?saved?.credentials}..remove('apiKey'),
                      ),
                    ),
              child: const Text('Remove saved API key'),
            ),
          if (hasBaseUrlOptions) ...[
            const SizedBox(height: 24),
            Text(
              'Base URL instance',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            RadioGroup<String>(
              groupValue: selectedEntry,
              onChanged: (value) {
                if (_busy || value == null) return;
                if (value == _defaultBaseUrlEntry) {
                  _write(
                    (store) => store.setCredentials(
                      plugin.id,
                      {...?saved?.credentials}..remove('baseUrlEntry'),
                    ),
                  );
                } else {
                  _write(
                    (store) => store.setCredentials(
                      plugin.id,
                      {
                        ...?saved?.credentials,
                        'baseUrlEntry': value,
                      },
                    ),
                  );
                }
              },
              child: Column(
                children: [
                  RadioListTile<String>(
                    key: const Key('plugin-baseurl-default'),
                    value: _defaultBaseUrlEntry,
                    title: const Text('(default)'),
                    subtitle: Text(defaultBaseUrl),
                    dense: true,
                  ),
                  for (final instance in plugin.baseUrls)
                    RadioListTile<String>(
                      key: ValueKey('plugin-baseurl-${instance.id}'),
                      value: instance.id,
                      title:
                          Text(instance.label ?? instance.url ?? instance.id),
                      subtitle: instance.url == null
                          ? null
                          : Text(instance.url!),
                      dense: true,
                    ),
                ],
              ),
            ),
          ],
        ],
        if (_busy) const LinearProgressIndicator(),
        if (_error != null) Semantics(liveRegion: true, child: Text(_error!)),
      ],
    );
  }
}

class _AgentEditor extends ConsumerWidget {
  const _AgentEditor({
    super.key,
    required this.agent,
    required this.configuration,
  });

  final AgentDto agent;
  final PluginAccountConfiguration configuration;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(scopedPluginCredentialsProvider);
    final isSelected = configuration.selectedAgent == agent.id;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(agent.name, style: Theme.of(context).textTheme.headlineSmall),
        Text(agent.description),
        const SizedBox(height: 16),
        if (agent.defaultModel case final model?)
          Text('Default model: $model'),
        if (agent.toolGrants.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('Grants access to:', style: Theme.of(context).textTheme.titleSmall),
          for (final grant in agent.toolGrants)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  if (grant.required)
                    Icon(Icons.lock, size: 16,
                      color: Theme.of(context).colorScheme.error),
                  const SizedBox(width: 4),
                  Text(grant.pluginId),
                ],
              ),
            ),
        ],
        if (agent.skillCount > 0) ...[
          const SizedBox(height: 12),
          Text('Includes ${agent.skillCount} skill bundle(s)'),
        ],
        if (agent.temperature != null || agent.maxTokens != null) ...[
          const SizedBox(height: 12),
          Text('Settings:'),
          if (agent.temperature != null)
            Text('Temperature: ${agent.temperature}'),
          if (agent.maxTokens != null)
            Text('Max tokens: ${agent.maxTokens}'),
          Text('Vision: ${agent.visionCapable ? 'Yes' : 'No'}'),
        ],
        const SizedBox(height: 24),
        if (isSelected)
          FilledButton(
            onPressed: () async {
              await ref.read(scopedPluginCredentialsProvider).setSelectedAgent(null);
            },
            child: const Text('Deselect agent'),
          )
        else
          FilledButton(
            onPressed: () async {
              await ref.read(scopedPluginCredentialsProvider).setSelectedAgent(agent.id);
            },
            child: const Text('Select agent'),
          ),
        if (!isSelected) ...[
          const SizedBox(height: 12),
          Text(
            'The Default agent will be used if you do not select one.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }
}
