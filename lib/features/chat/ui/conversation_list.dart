import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import './chat_providers.dart';
import '../../plugins/data/ledger_client.dart';
import '../data/database_providers.dart';

/// Full-screen conversation history browser. Tapping a conversation pops back
/// with its id; swiping left deletes it.
class ConversationListScreen extends ConsumerWidget {
  const ConversationListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conversations = ref.watch(conversationsProvider);
    final projections = ref.watch(backgroundJobProjectionsProvider);
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
          final pending =
              projections.value ?? const <String, LedgerTaskProjection>{};
          return ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: items.length,
            itemBuilder: (context, index) {
              final conversation = items[index];
              return Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 4,
                ),
                child: Dismissible(
                  key: ValueKey(conversation.id),
                  direction: DismissDirection.endToStart,
                  background: Container(
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.only(right: 20),
                    child: Icon(
                      Icons.delete,
                      color: Theme.of(context).colorScheme.onErrorContainer,
                    ),
                  ),
                  confirmDismiss: (_) => _confirmDelete(context),
                  onDismissed: (_) => store.deleteConversation(conversation.id),
                  // Card wrapper so each history entry reads as a tappable, delimited row
                  // rather than blending into its neighbours. Material (not a
                  // plain Container) so the ListTile's ink/splash paint on it.
                  child: Material(
                    color: Theme.of(context).colorScheme.surface,
                    elevation: 1,
                    shadowColor: Colors.black.withValues(alpha: 0.15),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(
                        color: Theme.of(context).colorScheme.outline,
                      ),
                    ),
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 2,
                      ),
                      title: Text(conversation.title),
                      subtitle: Text(_formatTime(conversation.updatedAt)),
                      trailing: pending[conversation.id] == null
                          ? null
                          : _PendingJobIndicator(
                              projection: pending[conversation.id]!,
                            ),
                      onTap: () => Navigator.pop(context, conversation.id),
                    ),
                  ),
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
  const _PendingJobIndicator({required this.projection});

  final LedgerTaskProjection projection;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final review = projection.code == LedgerTaskProgressCode.review;
    return Material(
      color: review ? scheme.tertiaryContainer : scheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(
          review ? Icons.rate_review_outlined : Icons.hourglass_top,
          size: 18,
          semanticLabel: review
              ? 'Background job awaiting review'
              : 'Pending background job',
          color: review ? scheme.onTertiaryContainer : scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
