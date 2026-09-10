import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_client.dart';
import '../../attachments/data/files_providers.dart';
import '../../attachments/data/files_service.dart';
import '../../settings/data/settings_providers.dart';
import '../../../app/theme.dart';
import '../../../app/widgets/gold_band.dart';
import '../../attachments/ui/attachment_picker.dart';
import '../../attachments/data/file_model.dart';
import '../../auth/ui/auth_flow.dart';
import '../../settings/ui/settings_screen.dart';
import '../../voice/ui/voice_screen.dart';
import './chat_providers.dart';
import './conversation_list.dart';
import './message_list.dart';
import '../data/message_model.dart';

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
  late String _conversationId;

  /// Files selected for the next message, cleared after a successful send.
  List<AttachmentDraft> _attachments = [];

  /// Mirrors [ConversationState.attachmentUploads] so the picker can observe
  /// status changes live.
  final ValueNotifier<Map<String, UploadJobStatus>> _uploadStatus =
      ValueNotifier(const {});

  @override
  void initState() {
    super.initState();
    _conversationId = ref.read(activeConversationIdProvider)!;
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    _uploadStatus.dispose();
    super.dispose();
  }

  void _newChat() {
    ref.read(activeConversationIdProvider.notifier).newConversation();
    setState(() {
      _attachments.clear();
      _uploadStatus.value = const {};
    });
    _input.clear();
  }

  Future<void> _openHistory() async {
    final selected = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const ConversationListScreen()),
    );
    if (selected != null && mounted) {
      ref.read(activeConversationIdProvider.notifier).set(selected);
    }
  }

  /// Re-authentication succeeded: the [AuthFlow] already minted + persisted a
  /// fresh API key. Swap the conversation's pinned client for one carrying the
  /// new key, then re-send the failed message.
  Future<void> _onReauthSuccess(AuthSession session) async {
    if (!mounted) return;
    final notifier = ref.read(conversationProvider(_conversationId).notifier);
    notifier.refreshClient();
    await notifier.retry();
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty) return;
    // Don't clear the input if a send can't actually start (e.g. the notifier
    // is still streaming or not DB-ready), otherwise the user's text would be
    // silently lost.
    final state = ref.read(conversationProvider(_conversationId)).value;
    if (state == null || state.isStreaming) return;

    final attachments = List<AttachmentDraft>.from(_attachments);

    // Critical (§3.6): the input is only cleared once the message has actually
    // been persisted. If the send fails before persisting (the notifier throws
    // before appending the user message), the input and attachment selection
    // are preserved so the user can retry.
    try {
      await ref
          .read(conversationProvider(_conversationId).notifier)
          .sendMessage(text, attachments: attachments);
    } catch (_) {
      return;
    }
    if (!mounted) return;

    final after = ref.read(conversationProvider(_conversationId)).value;
    final persisted = after != null &&
        after.messages.length > state.messages.length &&
        after.messages[state.messages.length].role == MessageRole.user &&
        after.messages[state.messages.length].content == text;
    if (!persisted) return;

    _input.clear();
    setState(() {
      _attachments.clear();
      _uploadStatus.value =
          ref.read(conversationProvider(_conversationId)).value
                  ?.attachmentUploads ??
              const {};
    });
  }

  /// Voice shortcut FAB. In the premium tier the FAB gets a metallic gold
  /// ring (§3.2: gold on the edge, never as a fill).
  Widget _buildVoiceFab() {
    final tier = Theme.of(context).extension<TierTheme>() ?? const TierTheme(premium: false);
    final fab = FloatingActionButton(
      tooltip: 'Voice Conversation',
      onPressed: () => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const VoiceScreen()),
      ),
      child: const Icon(Icons.mic),
    );
    if (!tier.premium) return fab;
    return GoldEdge(
      bandWidth: GoldBand.cta,
      radius: AppRadii.pill,
      fill: AppColors.paperRaised,
      child: Padding(
        padding: const EdgeInsets.all(GoldBand.cta),
        child: fab,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Track the app-wide active conversation reactively (shared with the voice
    // feature); _newChat / _openHistory switch it via the provider.
    final activeId = ref.watch(activeConversationIdProvider);
    if (activeId != null && activeId != _conversationId) {
      _conversationId = activeId;
    }
    final stateAsync = ref.watch(conversationProvider(_conversationId));
    final state = stateAsync.value;
    final isStreaming = state?.isStreaming ?? false;
    final isDbReady = state?.isDbReady ?? false;
    final error = state?.error;
    final authRequired = state?.authRequired ?? false;

    // Mirror the conversation's live upload progress into the picker's
    // notifier so AttachmentRow overlays update as jobs progress / complete /
    // fail. Runs on every rebuild while a provider change fires, so
    // `_uploadStatus` always reflects the current conversation.
    ref.listen<AsyncValue<ConversationState>>(
      conversationProvider(_conversationId),
      (_, next) {
        _uploadStatus.value = next.value?.attachmentUploads ?? const {};
      },
    );

    // Map each selected draft to its upload job (by local path) so the row can
    // look up a status overlay; drafts still being composed have none.
    final uploadStatus = state?.attachmentUploads ?? const {};
    final draftToJobId = <String, String>{
      for (final status in uploadStatus.values)
        if (status.uri != null) status.uri!: status.jobId,
    };

    final settings = ref.watch(settingsProvider).value;
    final settingsValid = settings?.isValid ?? false;

    // The files service is a NoOp until a files secret is configured; the
    // picker is then disabled with an explanatory hint.
    final filesConfigured = ref.watch(filesServiceProvider) is! NoOpFilesClient;
    final showAttachmentRow = filesConfigured || _attachments.isNotEmpty;

    final canSend = !isStreaming && isDbReady && _input.text.trim().isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        centerTitle: true,
        leading: IconButton(
          key: const Key('new-conversation'),
          tooltip: 'New Chat',
          icon: const Icon(Icons.add_comment_outlined),
          onPressed: _newChat,
        ),
        title: const Text('AI Assistant'),
        actions: [
          IconButton(
            key: const Key('history'),
            tooltip: 'History',
            icon: const Icon(Icons.history),
            onPressed: _openHistory,
          ),
        ],
      ),
      floatingActionButton: _buildVoiceFab(),
      body: Column(
        children: [
          if (!settingsValid) _ConfigureBanner(),
          if (authRequired)
            ReauthCard(
              onSuccess: _onReauthSuccess,
              onDismiss: () => ref
                  .read(conversationProvider(_conversationId).notifier)
                  .dismissAuthRequired(),
            ),
          Expanded(
            child: MessageList(
              messages: state?.messages ?? const [],
              isStreaming: isStreaming,
              error: authRequired ? null : error,
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
            attachmentRow: showAttachmentRow
                ? AttachmentRow(
                    attachments: _attachments,
                    onChanged: (updated) =>
                        setState(() => _attachments = updated),
                    uploadStatus: _uploadStatus,
                    draftToJobId: draftToJobId,
                    enabled: filesConfigured,
                  )
                : null,
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

/// Bottom input bar: multiline text field with a Send / Stop button, plus an
/// optional attachment picker row above it.
class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.isStreaming,
    required this.isDbReady,
    required this.canSend,
    required this.onSend,
    required this.onStop,
    required this.onChanged,
    this.attachmentRow,
  });

  final TextEditingController controller;
  final bool isStreaming;
  final bool isDbReady;
  final bool canSend;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final VoidCallback onChanged;

  /// Rendered above the text field when non-null.
  final Widget? attachmentRow;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tier = Theme.of(context).extension<TierTheme>() ?? const TierTheme(premium: false);
    return Material(
      color: scheme.surface,
      // Hairline divider instead of a cast shadow; premium upgrades it to a
      // gold hairline (§3.2).
      shape: Border(
        top: BorderSide(
          color: tier.premium ? AppColors.goldBase : scheme.outline,
          width: tier.premium ? GoldBand.hairline : 1.0,
        ),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (attachmentRow != null) ...[
                attachmentRow!,
                const SizedBox(height: 8),
              ],
              Row(
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
                  const SizedBox(width: 56),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
