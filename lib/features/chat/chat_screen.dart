import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/settings_providers.dart';
import '../settings/settings_screen.dart';
import 'chat_providers.dart';
import 'conversation_list.dart';
import 'message_list.dart';

/// Main conversation screen. Renders the message list plus an input bar, and
/// drives a single conversation via [conversationProvider].
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _uuid = const Uuid();
  String _conversationId = const Uuid().v4();

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _newChat() {
    setState(() => _conversationId = _uuid.v4());
    _input.clear();
  }

  Future<void> _openHistory() async {
    final selected = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ConversationListScreen()),
    );
    if (selected != null && mounted) {
      setState(() => _conversationId = selected);
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    // Don't clear the input if a send can't actually start (e.g. the notifier
    // is still streaming or not DB-ready), otherwise the user's text would be
    // silently lost.
    final state = ref.read(conversationProvider(_conversationId)).value;
    if (state == null || state.isStreaming) return;
    _input.clear();
    await ref
        .read(conversationProvider(_conversationId).notifier)
        .sendMessage(text);
  }

  @override
  Widget build(BuildContext context) {
    final stateAsync = ref.watch(conversationProvider(_conversationId));
    final state = stateAsync.value;
    final isStreaming = state?.isStreaming ?? false;
    final isDbReady = state?.isDbReady ?? false;
    final error = state?.error;

    final settings = ref.watch(settingsProvider).value;
    final settingsValid = settings?.isValid ?? false;

    final canSend = !isStreaming && isDbReady && _input.text.trim().isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: const Text('AI Assistant'),
        actions: [
          PopupMenuButton<String>(
            onSelected: (value) {
              switch (value) {
                case 'new':
                  _newChat();
                case 'history':
                  _openHistory();
                case 'settings':
                  Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const SettingsScreen()),
                  );
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'new', child: Text('New Chat')),
              PopupMenuItem(value: 'history', child: Text('History')),
              PopupMenuItem(value: 'settings', child: Text('Settings')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (!settingsValid) _ConfigureBanner(),
          Expanded(
            child: MessageList(
              messages: state?.messages ?? const [],
              isStreaming: isStreaming,
              error: error,
              onRetry: () => ref
                  .read(conversationProvider(_conversationId).notifier)
                  .retry(),
              isDbReady: isDbReady,
              scrollController: _scroll,
            ),
          ),
          _InputBar(
            controller: _input,
            isStreaming: isStreaming,
            isDbReady: isDbReady,
            canSend: canSend,
            onSend: _send,
            onStop: () => ref
                .read(conversationProvider(_conversationId).notifier)
                .stop(),
            onChanged: () => setState(() {}),
          ),
        ],
      ),
    );
  }
}

/// Non-blocking inline banner shown when the backend is not yet configured.
class _ConfigureBanner extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Icon(Icons.settings_outlined, color: scheme.onErrorContainer),
            const SizedBox(width: 12),
            const Expanded(
              child: Text('Backend not configured'),
            ),
            TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const SettingsScreen()),
              ),
              child: Text(
                'Configure Backend',
                style: TextStyle(color: scheme.onErrorContainer),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Bottom input bar: multiline text field with a Send / Stop button.
class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.isStreaming,
    required this.isDbReady,
    required this.canSend,
    required this.onSend,
    required this.onStop,
    required this.onChanged,
  });

  final TextEditingController controller;
  final bool isStreaming;
  final bool isDbReady;
  final bool canSend;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surface,
      elevation: 4,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  enabled: !isStreaming && isDbReady,
                  minLines: 1,
                  maxLines: 5,
                  onChanged: (_) => onChanged(),
                  textInputAction: TextInputAction.newline,
                  decoration: const InputDecoration(
                    hintText: 'Message…',
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.all(Radius.circular(24)),
                    ),
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              if (isStreaming)
                IconButton(
                  icon: Icon(Icons.stop, color: scheme.onSurface),
                  tooltip: 'Stop',
                  onPressed: onStop,
                )
              else
                IconButton(
                  icon: Icon(Icons.send, color: scheme.primary),
                  tooltip: 'Send',
                  onPressed: canSend ? onSend : null,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
