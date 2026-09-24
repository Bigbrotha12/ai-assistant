import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import './chat_providers.dart';
import '../data/database_providers.dart';

/// Full-screen conversation history browser. Tapping a conversation pops back
/// with its id; swiping left deletes it.
class ConversationListScreen extends ConsumerWidget {
  const ConversationListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conversations = ref.watch(conversationsProvider);
    final pendingIds = ref.watch(pendingConversationIdsProvider);
    final store = ref.read(chatStoreProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('History')),
      body: conversations.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load history')),
        data: (items) {
          if (items.isEmpty) {
            return const Center(child: Text('No conversations yet'));
          }
          final pending = pendingIds.value ?? const <String>{};
          return ListView.builder(
            itemCount: items.length,
            itemBuilder: (context, index) {
              final conversation = items[index];
              return Dismissible(
                key: ValueKey(conversation.id),
                direction: DismissDirection.endToStart,
                background: Container(
                  color: Theme.of(context).colorScheme.errorContainer,
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.only(right: 20),
                  child: Icon(
                    Icons.delete,
                    color: Theme.of(context).colorScheme.onErrorContainer,
                  ),
                ),
                confirmDismiss: (_) => _confirmDelete(context),
                onDismissed: (_) => store.deleteConversation(conversation.id),
                child: ListTile(
                  title: Text(conversation.title),
                  subtitle: Text(_formatTime(conversation.updatedAt)),
                  trailing: pending.contains(conversation.id)
                      ? const _PendingJobIndicator()
                      : null,
                  onTap: () => Navigator.pop(context, conversation.id),
                ),
              );
            },
          );
        },
      ),
    );
  }

  Future<bool> _confirmDelete(BuildContext context) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete conversation?'),
        content: const Text('This cannot be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  String _formatTime(DateTime time) {
    final now = DateTime.now();
    final difference = now.difference(time);
    if (difference.inMinutes < 1) return 'Just now';
    if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
    if (difference.inHours < 24) return '${difference.inHours}h ago';
    if (difference.inDays < 7) return '${difference.inDays}d ago';
    return '${time.year}-${time.month.toString().padLeft(2, '0')}-'
        '${time.day.toString().padLeft(2, '0')}';
  }
}

class _PendingJobIndicator extends StatelessWidget {
  const _PendingJobIndicator();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(
          Icons.hourglass_top,
          size: 18,
          semanticLabel: 'Pending background job',
          color: scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
